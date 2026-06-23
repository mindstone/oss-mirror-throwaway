---
description: "Principles and requirements for externalizing OAuth MCP connectors to open-source npm packages — auth modes, security, persistence, observability, mandatory pre-publish security review (AI-only, cross-family adversarial)"
last_updated: "2026-06-11"
---

# OAuth Connector Externalization Principles

Binding principles for migrating bundled OAuth MCP connectors (Slack, Google Workspace, HubSpot, Microsoft 365, Salesforce) to open-source npm packages. Derived from a septuple architectural review (7 independent reviewers, 3 model families).

**Status**: Principles finalized. Implementation deferred until after Wave 1 (API-key connectors).

## See Also

- [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md) — SDK patterns, module architecture, packaging, migration sequencing (covers API-key connectors)
- [MCP_CONNECTOR_WORKFLOW](MCP_CONNECTOR_WORKFLOW.md) — 6-phase workflow, authentication pattern decision tree, policies
- [MCP_CONNECTOR_AUTH_TOKEN_LIFECYCLE](MCP_CONNECTOR_AUTH_TOKEN_LIFECYCLE.md) — guardrails for token ownership, refresh behavior, reconnect UX, and per-connector auth risk
- [MCP_ARCHITECTURE](MCP_ARCHITECTURE.md) — Provider types, auth patterns, catalog schema, trust boundaries
- [260407 planning doc](../plans/260407_zendesk_sdk_upgrade_and_connector_npx_migration.md) — Full Wave 2 architecture design, per-connector specifics, review history
- `src/core/services/oauthCredentials.ts` — OAuth client credential resolution: env wins, then an optional injected provider (commercial desktop only), else `null` (see [Credential policy](#credential-policy))
- `scripts/check-commercial-capability-parity.ts` — CI gate asserting the commercial provider is complete, the OSS stub carries no literals, and the desktop bootstrap registers the provider
- `src/main/services/bundledMcpManager.ts` — Bridge env injection, post-auth restart
- `resources/mcp/hubspot/src/modules/accounts/callback-server.ts` — Existing localhost callback pattern (reference, not template — see security requirements below)

---

## Context

OAuth connectors are fundamentally harder to externalize than API-key connectors because they depend on:
1. Operator-supplied registered OAuth apps (client ID/secret at each provider)
2. Redirect infrastructure (Cloudflare Workers at `rebel-auth.mindstone.com`)
3. Bridge communication between the MCP server and Rebel's main process
4. Post-auth restart — Rebel kills and respawns the MCP with workspace-specific env vars

**Goal**: Code transparency and community contributions. Rebel remains the easy path for end users. Standalone mode targets developers and power users only.

<a id="credential-policy"></a>
**Credential policy**: client credentials resolve through `src/core/services/oauthCredentials.ts` with a precedence that differs by build:

**env wins → injected `@private/mindstone` provider fallback → `null`**

1. **Process env first, always.** Every provider reads `<PROVIDER>_CLIENT_ID` / `<PROVIDER>_CLIENT_SECRET` (Microsoft is PKCE/public-client, `MICROSOFT_CLIENT_ID` only). If the env pair is complete it is used, regardless of build. This is the per-operator / CI override and the documented local-dev path.
2. **Then an optional injected provider.** If env is incomplete, the resolver consults a provider registered at desktop bootstrap via `setOAuthCredentialsProvider(...)`. The **commercial desktop** build registers a real provider through the `@private/mindstone` alias (`private/mindstone/src/services/oauthCredentialsProvider.ts`), restoring the zero-config credentials the OSS-scrub removed — without re-embedding secrets in shared source.
3. **Else `null`** — surfaced as an explicit unconfigured/auth-required result, never a silent guess.

Per-surface reality:

| Surface | Resolution | Zero-config credentials? |
|---------|-----------|--------------------------|
| OSS desktop | env only (registers the empty stub provider — `get()` returns `null`) | No — broken-by-default until the operator registers their own OAuth app + env vars |
| Commercial desktop | env, then injected `@private/mindstone` provider | Yes |
| Cloud-service / mobile | env only (register **nothing**) | No — broken-by-default |

`src/core` (and therefore the cloud-service and mobile surfaces) **must not import `@private/mindstone`** — that alias resolves only in the desktop main bundle. Cloud and mobile stay env-only by construction. The CI gate `scripts/check-commercial-capability-parity.ts` enforces this: the commercial provider must be complete, the OSS stub must contain no credential literals, and the desktop bootstrap must actually call `setOAuthCredentialsProvider(LIVE_OAUTH_CREDENTIALS_PROVIDER)`. See [`docs/plans/260608_commercial-oauth-creds-restore/PLAN.md`](../plans/260608_commercial-oauth-creds-restore/PLAN.md).

---

## 1. Auth Mode Architecture

### 1.1 Four auth modes, detected at startup

Each externalized OAuth connector supports exactly four modes, detected once at startup:

| Mode | Detection | Who uses it | Description |
|------|-----------|-------------|-------------|
| `bridge` | Bridge state env var is set | Rebel users | Unchanged. Rebel handles OAuth in main process, restarts MCP with tokens |
| `standalone_oauth` | Provider client ID (+ secret where required) set, no bridge | Developers with their own OAuth app | Localhost callback server, in-process token management |
| `manual_token` | Provider-specific static token env var set | Quick-access developers | Static bearer token, no refresh, reduced capability |
| `unconfigured` | No auth-related env vars | First-run / misconfigured | Tools return setup instructions pointing to README |

### 1.2 Mode is an explicit enum, not implicit fallthrough

```typescript
type AuthMode = 'bridge' | 'standalone_oauth' | 'manual_token' | 'unconfigured';
```

Resolve mode once at startup. Store it. Use it for all branching. Do not re-detect from env vars on each tool call.

### 1.3 On conflicting env vars, fail loudly

If contradictory env vars are detected (e.g., bridge state AND client credentials AND static token), log a diagnostic error explaining the conflict and which mode was selected. Never silently pick a mode when the intent is ambiguous.

Precedence: `bridge` > `standalone_oauth` > `manual_token` > `unconfigured`.

### 1.4 Manual-token mode is opt-in per connector

Not all providers have a useful "static token" concept. Short-lived access tokens (Google, Microsoft, HubSpot) are useless as manual tokens. Only implement manual-token mode where the provider offers long-lived tokens (e.g., Slack bot tokens, Salesforce session tokens). Document which capabilities are lost.

### 1.5 Startup without credentials must be non-fatal

Several current connectors crash if OAuth credentials are missing (Google `GoogleOAuthClient`, HubSpot `HubSpotOAuthError`). Externalized connectors MUST enter `unconfigured` mode gracefully. Wrap initialization in guarded paths. Return setup instructions from all tools instead of crashing.

---

## 2. Provider Capability Matrix

Do not assume one auth contract fits all. Before implementing each connector, document its position in this matrix:

| Dimension | Varies across providers |
|-----------|------------------------|
| **Secret requirement** | Slack/HubSpot/Google/Salesforce require client secret. Microsoft uses PKCE (public client, no secret) |
| **Redirect URI port rules** | Slack: exact match including port (fixed port required). Google/Microsoft: `http://localhost` without port (native app exemption). HubSpot: any localhost port |
| **Multi-account model** | Slack: multi-workspace keyed by team ID. Google: multi-account keyed by email. Microsoft: single account. HubSpot: multi-portal. Salesforce: per-org |
| **Token schema** | Each provider has different token payloads, refresh mechanisms, and metadata requirements |
| **Refresh behavior** | Slack: rotating refresh tokens (12h). Google: offline tokens (long-lived). Microsoft public client: 24h refresh. HubSpot: 6h access, 6-month refresh. Salesforce: session-based |
| **Incremental consent** | Microsoft supports incremental scope additions. Others require full re-auth for scope changes |
| **Granted vs requested scopes** | HubSpot returns `granted_scope` which may differ from requested. Slack grants per-token-type. Validate post-auth |

**Principle**: The per-connector `standaloneAuth` implementation must respect these differences. A shared template is a starting point, not a complete solution.

---

## 3. State & Initialization

### 3.1 Lazy initialization is necessary but insufficient

Changing `const tokenProvider` to `let tokenProvider` enables post-auth initialization. But swapping one variable is not enough. When auth state changes, ALL dependent state must be rebuilt:

- **Slack**: Null out `_slackClient`, `_slackUserClient`, `_lastBotToken`, `_lastUserToken` to force client re-creation
- **Google**: Invalidate `BaseGoogleService.apiClients` cache and re-run deferred service initialization
- **Microsoft**: Rebuild Graph client middleware (it closes over the provider instance at construction)
- **Salesforce**: Clear `connections` Map in AccountManager (jsforce Connection stores accessToken internally)

**Principle**: Every connector must document a **cache invalidation checklist** — the complete list of singletons, caches, and closures that must be reset when auth state changes.

### 3.2 One auth session per connector process

Reject or serialize concurrent auth attempts. Use a mutex/flag (`authInProgress`). If a second auth request arrives while one is pending, return "auth already in progress" rather than racing.

### 3.3 Provider identity comes from the OAuth response

In Rebel bridge mode, identity env vars (`SLACK_TEAM_ID`, `MS_EMAIL`, `SALESFORCE_ACCOUNT_ID`) are injected during restart. In standalone mode, these values must be extracted from the OAuth token exchange response and persisted alongside tokens. The connector cannot function without them.

### 3.4 Do not expose raw mutable tokenProvider

Use an accessor/assertion layer so "not authenticated yet" is a typed, deliberate runtime state. Tools should get clear `{ ok: false, error: 'not_connected', action_required: 'authenticate' }` responses, not null reference crashes.

---

## 4. Localhost OAuth Security

### 4.1 Hardened callback server requirements

Do NOT copy existing callback server patterns (HubSpot, Google) without hardening. Current implementations have known gaps. All standalone OAuth callback servers MUST:

- **Bind to `127.0.0.1` only** (not `0.0.0.0`). Support configurable bind host via `MCP_OAUTH_BIND_HOST` env var for Docker/container environments, defaulting to `127.0.0.1`
- **Use one-time cryptographic `state` parameter** — random bytes + HMAC, verified before accepting callback. Existing implementations do not consistently validate state
- **Use PKCE** (`code_verifier` + `code_challenge`) where the provider supports it, even when a client secret is available
- **Shut down immediately** after receiving callback (success or failure) or after timeout (5 minutes max)
- **Never embed auth codes, state, or tokens in HTML/JS responses** — use a minimal static success/error page
- **Use a fixed, documented port** where the provider requires exact redirect URI match (Slack). Use OS-assigned port where the provider allows `http://localhost` without port (Google, Microsoft)

### 4.2 Port strategy is per-provider

| Provider | Port strategy | Reason |
|----------|--------------|--------|
| Slack | Fixed (e.g., `8742`, configurable via env) | Requires exact redirect URI match including port |
| Google | OS-assigned (port 0) | Allows `http://localhost` without port for native apps |
| Microsoft | OS-assigned (port 0) | Allows `http://localhost` for public clients |
| HubSpot | Sequential probe (8081+) or OS-assigned | Allows any localhost port |
| Salesforce | Fixed or OS-assigned | Verify during implementation |

---

## 5. Token Persistence & Recovery

### 5.1 Atomic writes

Token files contain long-lived credentials (refresh tokens). Writes must be crash-safe:
1. Write to a temporary file in the same directory
2. `fsync` the file descriptor
3. Rename (atomic on POSIX) to the final path

Current implementations write directly to the final path. Fix during extraction.

### 5.1b File permissions (STOP gate)

All credential file writes MUST include `{ mode: 0o600 }`. All credential directory creation MUST include `{ mode: 0o700 }`. This is already required by [MCP_SERVER_STANDARD § Security Baseline](MCP_SERVER_STANDARD.md#4-security-baseline) but was not enforced in connectors built before the standard (Google Workspace, HubSpot, Salesforce, Microsoft). See [260409_mcp_credential_security_hardening.md](../plans/260409_mcp_credential_security_hardening.md) for the full audit and remediation plan. Fix all permission gaps BEFORE externalizing any OAuth connector.

### 5.2 Fail visibly on persistence failure

Never log-and-continue when saving tokens fails. If the token write fails, the tool call that triggered auth must receive an error. The user must know their auth state is not persisted.

### 5.3 Distinguish error types

Treat corruption, missing file, and permission-denied as distinct errors with distinct recovery guidance:
- **Missing**: Normal first-run state → guide to authenticate
- **Corrupt**: Data loss → warn, delete, guide to re-authenticate
- **Permission denied**: OS/environment issue → surface specific error with path

### 5.4 Version token file schemas

Add a `schemaVersion` field to token files. When the connector version introduces a new schema:
1. Read existing file
2. Check version
3. If old version: migrate with backup (rename original to `.bak`)
4. If unknown/future version: fail with diagnostic, do not overwrite

### 5.5 Isolate Rebel and standalone storage

Rebel tokens: `userData/mcp/{provider}/`. Standalone tokens: `~/.mcp/{provider}/` (or configurable via `{PROVIDER}_CONFIG_PATH`). Never auto-share paths. If a user points standalone at Rebel's storage path, the schemas must be compatible or the connector must refuse with a diagnostic.

### 5.6 Host-Coordinator Sync Authority (OSS subprocesses own refresh)

> **Updated 2026-05-26** per [`docs/plans/260526_oauth_token_sync_vendor_agnostic_redesign.md`](../plans/260526_oauth_token_sync_vendor_agnostic_redesign.md) and the diagnosis at [`docs-private/investigations/260525_cloud_connector_oauth_refresh_authority.md`](../../docs-private/investigations/260525_cloud_connector_oauth_refresh_authority.md).

**Principle**: OSS connector subprocesses perform OAuth refresh on every surface. The host owns **cross-surface token sync**, not vendor-specific refresh logic. The coordinator lives at `src/core/services/tokenSync/`.

**Implementation contract**:
- Cloud refresh is enabled by default (same OSS behavior as desktop).
- `*_DISABLE_REFRESH=1` is only injected when `OSS_SYNC_DISABLED=1` is explicitly set (advanced sync-disable escape hatch).
- Host sync coordinator wiring is required on desktop and cloud via `setTokenSyncCoordinator(...)`.

**Cross-surface convergence mechanism**:
- **WS metadata signal** (`tokens:provider-changed`) carries only `{ provider, accountKey, expiryEpochMs, mtimeMs, surfaceWrote }`.
  - Strict schema validation.
  - Payload capped at 256 bytes.
  - Token-shaped fields rejected.
  - Handled in main process only; never renderer-forwarded.
- **Authenticated HTTP pull**:
  - `GET /api/auth/relay/<provider>/<path>/metadata` (metadata)
  - `GET /api/auth/relay/<provider>/<path>` (token payload)
  - Shared-bearer auth, hardened path handling, per-bearer rate limiting, hashed-account audit logs.
- **Tombstones**: `DELETE /api/auth/relay/<provider>/<path>` with `tombstoneEpochMs`; peer unlinks only when its local file is older than the tombstone.

**Pre-tool hook**:
- `createTokenSyncPreflightHook` in `agentTurnExecute.ts` performs best-effort sync (`~3s` budget) for OAuth-backed tools before execution.
- No-op when resolver cannot classify the tool or when NULL coordinator sentinel is wired.

**Anti-pattern — DO NOT**:
- Reintroduce host-side provider-specific refresh adapters (`tokenCoordinator/providers/*` shape).
- Force `{CONNECTOR}_DISABLE_REFRESH=1` on cloud by default.
- Carry token contents on WS signals.
- Add parallel refreshers in feature-specific services (calendar sync, provider API helpers, etc.).

### 5.6.1 Multi-account isolation, advisory lease, and deterministic merge rules

**Account isolation**: all sync operations are keyed on `(provider, accountKey)`; multi-account providers remain isolated.

**Cross-process lease**: sync write paths use `CrossProcessLease` as an advisory guard around pull→write operations (desktop and cloud implementations). This is best-effort local-process coordination, not distributed locking.

**Deterministic merge rules**:
1. **Primary**: `expiryEpochMs` descending (newer expiry wins).
2. **Tie**: cloud-prefers-on-tie (deterministic replay behavior).

These rules are encoded in `src/core/services/tokenSync/merge.ts` and consumed by `TokenSyncCoordinator`.

---

## 6. Observability & UX

### 6.1 Startup mode banner

Every connector logs at startup which mode was detected and which env vars were found:
```
[slack-mcp] Auth mode: standalone_oauth (client_id: xoxb-***789)
[slack-mcp] Auth mode: bridge (rebel v1.2.3)
[slack-mcp] Auth mode: unconfigured — no auth env vars detected
```

### 6.2 Status tool contract

Every connector exposes a status/list tool that returns a standardized shape:

```typescript
{
  authMode: 'bridge' | 'standalone_oauth' | 'manual_token' | 'unconfigured',
  connected: boolean,
  capabilities: string[],          // e.g., ['read', 'write', 'search'] — varies by mode
  action_required?: string,        // e.g., 'authenticate', 'refresh_failed', 'upgrade_token'
  lastRefreshAt?: string,          // ISO timestamp
  tokenSource: 'disk' | 'env' | 'bridge' | 'none',
}
```

### 6.3 Mode-specific UX strings

Do not share UX strings across modes. Specifically:
- No "restart_package" instructions in standalone mode
- No "Settings → Integrations" references outside Rebel bridge mode
- No "call this bridge endpoint" in unconfigured mode

Each mode has its own recovery guidance. Factor these into a `modeMessages` map, not inline conditionals.

### 6.4 Capability-gated tool responses

Tools that are unavailable in the current mode (e.g., user-token-only Slack tools in manual-token mode) must return a deterministic capability error:
```json
{ "ok": false, "error": "capability_not_available", "reason": "This tool requires a user token. Current mode (manual_token) only has a bot token.", "resolution": "Re-authenticate with standalone OAuth to get both bot and user tokens." }
```
Do not return generic "reconnect" noise.

---

## 7. Supply Chain & Publication

### 7.1 Version pinning in Rebel

Rebel's connector catalog must pin exact versions for OAuth connectors (`@scope/mcp-server-slack@0.2.0`), not `@latest` or implicit latest. This is already policy for community connectors — extend it to first-party.

### 7.2 Publication governance

Before publishing any OAuth connector to npm:
- npm 2FA mandatory on publisher accounts
- Minimal publisher set (1-2 people)
- npm provenance attestation enabled
- Documented emergency revoke/unpublish path
- CHANGELOG with security-relevant version notes

### 7.3 No client credentials in published packages

OAuth client IDs and client secrets must never appear in the published npm package, git repository, README examples, or error messages. The published connector resolves credentials from env only — the injected `@private/mindstone` provider that backs Rebel's commercial desktop build (see [Credential policy](#credential-policy)) lives in the desktop host, never in the OSS-published package or its git history. In a standalone/published context `oauthCredentials.ts` therefore returns `null` when the env pair is absent; consumers must surface that state clearly.

---

## 8. Testing Strategy

### 8.1 Per-mode integration tests

Each connector needs integration tests for each supported auth mode. Minimum coverage:

| Test | What it verifies |
|------|-----------------|
| Status tool per mode | Returns correct `authMode`, `connected`, `capabilities` |
| Authenticate tool per mode | Bridge triggers bridge flow; standalone starts localhost server; manual returns instructions; unconfigured returns setup guide |
| One read tool | Works correctly after auth in each mode |
| User-token-only tool | Returns capability error in manual-token mode |
| Refresh failure | Returns structured re-auth guidance, not crash |
| Conflicting env vars | Correct mode selected, warning logged |
| Missing credentials startup | Enters `unconfigured` mode without crash |

### 8.2 Callback server tests

Test the localhost OAuth callback server in isolation:
- Binds to `127.0.0.1` (not `0.0.0.0`)
- Rejects callbacks with wrong/missing `state`
- Shuts down after success
- Shuts down after timeout
- Handles port-in-use gracefully

### 8.3 Token persistence tests

- Atomic write: kill process mid-write → old file survives
- Schema migration: old-version token file → migrated correctly
- Permission denied: clear error, not silent "not authenticated"

---

## 9. Shared Primitives vs Per-Connector Code

### 9.1 What to share

Create a shared `@rebel-mcps/oauth-helpers` package (or internal module) for:
- Localhost callback server with security hardening (bind, state, PKCE, timeout, cleanup)
- Auth mode detection logic (env var parsing, conflict detection, precedence)
- Token file utilities (atomic write, schema versioning, permission checks)
- Standard error response shapes
- Startup mode banner logging

### 9.2 What stays per-connector

- OAuth URL construction (scopes, provider-specific params, consent prompts)
- Token exchange (different response shapes per provider)
- Cache invalidation checklist (different singletons per connector)
- Port strategy (fixed vs dynamic, per provider requirement)
- Scope validation (granted vs requested, provider-specific rules)
- Provider identity extraction from OAuth response

### 9.3 Drift prevention

Current codebase already shows drift (HubSpot scopes duplicated with "KEEP IN SYNC" warnings). The shared package is the antidote. Per-connector code should be thin adapters over shared primitives.

---

## 10. Per-Connector Reality

Effort varies ~5x across connectors. These are evidence-based estimates from the septuple review:

| Connector | Estimated effort | Key deviations from base pattern |
|-----------|-----------------|----------------------------------|
| **HubSpot** | ~100 lines | Already has localhost callback. Needs security hardening + env detection wiring. Closest to plan |
| **Salesforce** | ~200 lines | Sandbox/production URL handling. jsforce connection cache invalidation. Already user-provided credentials |
| **Slack** | ~300+ lines | Fixed port requirement. Team ID management from OAuth response. Client cache invalidation across 4 singletons. 10+ hardcoded UX strings to make mode-aware |
| **Microsoft 365** | ~400 lines | BLOCKED until microsoft-shared published as npm package. PKCE implementation. Graph client middleware rebuild. 24hr public client token lifetime. Incremental consent |
| **Google Workspace** | ~500-800 lines | Eager init across 10+ service modules needs deferred init refactor. ~190MB googleapis dependency. Consent screen documentation. Scope management |

---

## 11. Implementation Sequence

Each step is independently shippable:

1. **Shared primitives package** — hardened callback server, auth mode detection, token utilities
2. **Lazy init + cache invalidation refactor** — per-connector, in monorepo, backwards-compatible
3. **Non-fatal startup** — wrap OAuth constructors that currently crash on missing credentials
4. **Mode-aware UX strings** — remove hardcoded "restart_package" and "Settings" references
5. **HubSpot extraction** — easiest OAuth connector, validates the pattern
6. **Salesforce extraction** — already closest to standalone
7. **Slack extraction** — fixed port, multi-workspace, most complex UX string refactor
8. **Google Workspace extraction** — deferred init, large dependency, consent screen docs
9. **Microsoft 365 extraction** — last, blocked on microsoft-shared npm publication

---

## 12. Bridge Env Var Standardization

The plan currently uses `MCP_HOST_BRIDGE_STATE` but most connectors use `MINDSTONE_REBEL_BRIDGE_STATE`. Before Wave 2 implementation:
- Audit all connectors for bridge env var naming
- Standardize on one name
- Update `bundledMcpManager.ts` env injection to match
- Document the canonical name in this doc and MCP_SERVER_STANDARD

---

## 13. Mandatory Pre-Publish Security Review

**STOP gate.** No OSS MCP connector — OAuth, API key, or otherwise — may be published to npm or pinned in `resources/connector-catalog.json` until this review is complete and its Release Gate block (§ 13.8) validates. This applies to first publication, every minor / major version bump, and any patch that touches the auth, network, IPC, persistence, or dependency surface. The review is **AI-only with a mandatory cross-family adversarial pass** (§ 13.2); release authorization is a separate act (§ 13.8).

This section is the canonical pre-publish security gate for `provider: "rebel-oss"` connectors. The technical requirements in §§ 4, 5, 7, and 8 above, the OSS-readiness rules in [MCP_SERVER_STANDARD § OSS Readiness](MCP_SERVER_STANDARD.md#oss-readiness), and the OSS Connector Security policy in [MCP_CONNECTOR_WORKFLOW § Critical: OSS Connector Security](MCP_CONNECTOR_WORKFLOW.md#critical-oss-connector-security) are the **substance**. This section is the **process** that ensures they are actually verified before bytes ship.

> Catalog pin = production deployment. The moment a version lands in `resources/connector-catalog.json`, every Rebel user receives it on next app launch via the startup migration chain (see [MCP_OSS_CONNECTORS § Startup Migration Chain](MCP_OSS_CONNECTORS.md#startup-migration-chain) and [MCP_UPDATE_LIFECYCLE § npx version reconciliation](MCP_UPDATE_LIFECYCLE.md#npx-version-reconciliation-startup-migration)). There is no "soft launch" — the only place to gate is here.

### 13.1 When the review is required

**Full review (§§ 13.2–13.5)** mandatory before:

- First npm publish of any new OSS connector
- Any version bump that ships in `resources/connector-catalog.json`
- Any change touching: auth flow, callback server, token persistence, file permissions, network egress, IPC contract, dependency tree, or `package.json` `bin` / `main` / `exports` resolution
- Any change to the client credential policy or `oauthCredentials.ts` resolution (see [Credential policy](#credential-policy))

**Abbreviated review (§ 13.6)** is permitted only for patch releases that meet the strict criteria there. If in doubt, do the full review.

### 13.2 Required review (AI-only)

> **Policy revision (2026-06-11)**: the review is **AI-only** — there is no human reviewer stage. Per Greg (verbatim): "We don't want a human reviewer stage - we want a careful, trustworthy, consistent AI-only process." Release **authorization** (approving the merge/push that ships the release) remains a distinct act — see § 13.8 — but it is an authorization act, not a review.

Every full review requires at minimum:

1. **Agent-written security review** — the releasing agent runs the security lens (`lens-security` or an equivalent security-specialist dispatch) explicitly against the diff and the connector's full source tree, and authors the review artifact. Output: structured findings tagged Critical / High / Medium / Low, with file references. The artifact records the author's model ID, session ID, and confidence.
2. **Cross-family adversarial pass — MANDATORY.** An adversarial reviewer from a **different model family than the author** (if the author is a Claude model, the adversary must be GPT, Gemini, GLM, Kimi, MiniMax, …, and vice versa). The adversarial reviewer must read the **diff and the relevant source** (not just the review artifact), actively attempt to refute the review's claims, and record in the artifact: its **model ID**, **session ID**, **confidence**, and a **verdict**. Corrections are incorporated into the artifact before release. A verdict of `UPHELD` (or `UPHELD-WITH-ADDENDA`, when the adversarial pass contributed addenda that are incorporated) is a publish precondition (§ 13.4). Exemplar: `docs-private/reports/security-reviews/260611_retell-ai_0.2.3.md`.
3. **Release authorization** — recorded as `Release-Authorized-By` in the Release Gate block (§ 13.8): the operator's name, or a reference to the standing policy under which the release is authorized. This approves shipping; it does not re-verify findings. (Legacy artifacts record this as `Human-Signoff`; the verifier treats that field as an alias.)

For OAuth connectors specifically, an additional `lens-operational` review SHOULD run to assess refresh-failure recovery, fail-closed behaviour, and degraded-mode UX. For first-time externalization of any provider, `lens-behavioral-safety` SHOULD run to flag silent-failure patterns.

### 13.3 Required artifacts

The review record (committed to `docs-private/reports/security-reviews/<yyMMdd>_<connector>_<version>.md`) MUST include:

- **Threat model** — minimum: trust boundaries, untrusted inputs, secrets in scope, network destinations, persisted data, per-mode capability differences. STRIDE or the security-lens template is acceptable.
- **Pre-merge + OSS-readiness checklist evidence** — every box from [MCP_SERVER_STANDARD § Pre-Merge Checklist](MCP_SERVER_STANDARD.md#7-pre-merge-checklist) plus § 13.5 below, with a one-line note or commit / file reference per item. Unchecked boxes block publish.
- **Callback-server test evidence** (OAuth) — pasted test output or test-file reference for: 127.0.0.1 bind, state validation (generation + consumption), PKCE where applicable, 5-minute timeout shutdown, port-in-use handling, Origin / Content-Type validation on POST.
- **File-permission audit** — output of a script or grep proving every credential write uses `{ mode: 0o600 }` AND has a follow-up `fs.chmod(file, 0o600)`, every credential dir uses `{ mode: 0o700 }`. Existing-file path explicitly covered (mode-on-create alone is insufficient — see [MCP_SERVER_STANDARD § File Permissions](MCP_SERVER_STANDARD.md#file-permissions)).
- **Atomic-write evidence** — proof token writes use temp + rename, with mid-write kill test result.
- **Internal-reference scan** — output of `rg -i 'mindstone|rebel|nspr' --glob '!LICENSE' --glob '!package.json' --glob '!node_modules' src/ test/` returning zero matches.
- **Secrets scan** — `gitleaks detect` (or equivalent) returning zero matches; explicit confirmation that no provider OAuth `client_id` / `client_secret` is present in source, git history, README, error messages, or test fixtures.
- **`npm audit` report** — clean of Critical and High vulnerabilities. Document any deferred Medium / Low with rationale and tracking issue.
- **SBOM** — generate via `npm sbom --sbom-format=spdx` (or equivalent) and attach.
- **Reviewer findings** — full findings from the author's security review and the cross-family adversarial pass, with a disposition note on every finding (Fixed / Accepted-with-rationale / Deferred-with-tracking-issue), and the adversarial pass's corrections incorporated.

### 13.4 Blocking conditions (cannot publish)

Publish is **blocked** if any of the following are true:

- Any **Critical** finding from any reviewer is in `Open` state. Critical findings must be **Fixed** before publish — they cannot be accepted with rationale or deferred.
- Any **High** finding is `Open`. High findings must be Fixed or have a named-maintainer waiver with a tracking issue.
- `npm audit` reports a Critical or High vulnerability with no documented mitigation.
- Internal-reference scan returns matches outside the allowlist (LICENSE, `package.json` author / scope).
- Secrets scan returns any match.
- Any credential write or directory creation lacks explicit `mode` AND `chmod`.
- Any token write is non-atomic (direct write to final path).
- Callback server (OAuth) lacks any of: 127.0.0.1 bind, cryptographic state validation, timeout shutdown, security headers (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`).
- Bridge code (`bridge.ts`, `MINDSTONE_REBEL_BRIDGE_STATE`, localhost bridge calls) is present in OSS source.
- npm 2FA is not enabled on every publisher account.
- The Release Gate block (§ 13.8) is missing or fails machine validation. For new-format artifacts that means: any required field absent or placeholder, `Adversarial-Verdict` not `UPHELD` / `UPHELD-WITH-ADDENDA`, `Adversarial-Model` in the same model family as `Author-Model`, or `Release-Authorized-By` empty / placeholder. Legacy `Human-Signoff`-only artifacts (predating the AI-only fields) remain valid without the model / verdict fields — see § 13.8.

### 13.5 Pre-publish security checklist

In addition to the standard pre-merge and OSS-readiness checklists in MCP_SERVER_STANDARD, the following items MUST be ticked:

**Auth surface:**
- [ ] Auth mode detection is an explicit enum, not implicit fallthrough (§ 1.2)
- [ ] Conflicting env vars fail loudly with diagnostic, not silent precedence (§ 1.3)
- [ ] Startup without credentials enters `unconfigured` mode without crash (§ 1.5)
- [ ] One auth session per process — concurrent auth attempts serialized or rejected (§ 3.2)
- [ ] `tokenProvider` exposed via accessor with typed not-yet-authed state, not raw mutable export (§ 3.4)
- [ ] Cache-invalidation checklist documented and exercised by test (§ 3.1)

**Localhost callback (OAuth):**
- [ ] Binds to `127.0.0.1` only (verified by test, not assertion in code comment)
- [ ] One-time cryptographic state parameter generated, validated on GET, **consumed** on POST `/complete-auth` before processing
- [ ] PKCE used wherever the provider supports it, even when a client secret is also available
- [ ] Shuts down on success, on failure, AND on 5-minute timeout (each verified by test)
- [ ] No auth code, state, or token embedded in HTML or inline JS response body
- [ ] Security headers on every response: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`
- [ ] Origin and Content-Type validated on POST endpoints

**Token persistence:**
- [ ] Atomic write (temp + rename) — verified by mid-write kill test
- [ ] `{ mode: 0o600 }` on file write AND explicit `fs.chmod(file, 0o600)` after (catches existing files from prior versions)
- [ ] `{ mode: 0o700 }` on credential directory creation
- [ ] `schemaVersion` field in token file; migration path documented and tested
- [ ] Persistence failure surfaces as a tool-call error, not log-and-continue (per "silent failure is a bug")
- [ ] Distinct error types for missing / corrupt / permission-denied (§ 5.3)

**Capability and UX:**
- [ ] Status tool returns standardized shape (§ 6.2) including `authMode`, `connected`, `capabilities`, `tokenSource`
- [ ] Mode-specific UX strings — no `restart_package` outside bridge mode, no Settings references outside bridge mode (§ 6.3)
- [ ] Capability errors are deterministic structured shape, not generic "reconnect" noise (§ 6.4)
- [ ] All user-facing strings are host-neutral (no "Mindstone", "Rebel", "Claude Desktop")

**Supply chain:**
- [ ] npm 2FA mandatory on all publisher accounts (verified, not assumed)
- [ ] Publisher set documented and minimal (1–2 people)
- [ ] npm provenance attestation enabled in publish workflow
- [ ] Catalog pin is exact semver, never `@latest` or range (§ 7.1)
- [ ] CHANGELOG entry present and includes any security-relevant changes
- [ ] Documented emergency revoke / unpublish path (where in repo, who has access)

**Client credentials:**
- [ ] Provider OAuth `client_id` / `client_secret` absent from published package, OSS git history, README, error messages, and test fixtures (verified by grep + git log scan)

### 13.6 Abbreviated review for non-security patches

A patch release qualifies for abbreviated review **if and only if** its diff:

- Does not touch any file under `auth/`, `callback*`, `tokens*`, `oauth*`, network calls, IPC schemas, file I/O for credentials, or `package.json` `bin` / `main` / `exports` / `dependencies`
- Does not change any dependency version (including transitive — verified via lockfile diff)
- Does not modify error messages or User-Agent strings (internal-reference and host-neutrality risk)

Abbreviated review still requires:

- Agent-written security review of the diff (§ 13.2 item 1)
- Cross-family adversarial pass (§ 13.2 item 2 — required for abbreviated reviews too)
- Internal-reference and secrets scans
- `npm audit` clean
- Release Gate block + authorization recorded in `docs-private/reports/security-reviews/` (§ 13.8)

If any abbreviated criterion fails, the full review (§§ 13.2–13.5) is required. Default to full review when in doubt.

### 13.7 Re-review triggers between publishes

Even if a connector's source is unchanged, a re-review is required when:

- A dependency in the connector's tree has a new Critical or High advisory and the connector has not been re-published
- The provider changes its OAuth contract (redirect URI rules, token lifetimes, scope semantics)
- Client credential policy or `oauthCredentials.ts` resolution changes (see [Credential policy](#credential-policy))
- A postmortem identifies a class of bug that may apply to this connector

Re-review may be abbreviated (§ 13.6) when scope is genuinely limited to the trigger.

### 13.8 Release Gate block & sign-off record

The review artifact MUST contain a machine-readable `Release Gate` block (canonical template: [MCP_RELEASE_SECURITY_REVIEW_TEMPLATE](../../docs-private/security/MCP_RELEASE_SECURITY_REVIEW_TEMPLATE.md)). The `mcp:release` script validates the block before any release action (`validateSecurityReviewGateFields` in `scripts/mcp-release.ts`); every field below is required on new-format artifacts — the legacy exception is noted beneath:

```
Security-Review-Gate: Approved | Approved-with-deferred-findings
Connector: <connector-directory-name>
Package: @mindstone/mcp-server-<connector>
Version: <x.y.z>
Critical-Findings-Open: 0
High-Findings-Open: 0
Author-Model: <model ID of the review author>
Adversarial-Model: <model ID — must be a different model family than Author-Model>
Adversarial-Verdict: UPHELD
Release-Authorized-By: <operator name or standing-policy reference>
```

Accepted `Adversarial-Verdict` values are `UPHELD` and `UPHELD-WITH-ADDENDA` (an upheld review whose adversarial pass contributed addenda, incorporated before release). **Legacy exception**: artifacts predating the 2026-06-11 AI-only revision carry `Human-Signoff` instead of `Release-Authorized-By` and omit the `Author-Model` / `Adversarial-Model` / `Adversarial-Verdict` fields entirely — the verifier accepts those as-is (`Human-Signoff` acts as an alias for `Release-Authorized-By`, and the model / verdict fields are not required). New artifacts MUST carry all four AI-provenance fields.

A free-form sign-off record at the bottom of the document captures the provenance detail:

```
Reviewers (AI):        <author model + session ID + confidence;
                        adversarial model + session ID + confidence + verdict>
Release authorization: <operator name or standing-policy reference>
Disposition:           Approved | Approved-with-deferred-findings | Blocked
Catalog version:       <semver pinned in connector-catalog.json>
npm dist-tag + SHA:    <git SHA + npm dist-tag>
Date:                  <ISO date>
```

The releasing agent cross-links this document from:

- The `connector-catalog.json` entry (via inline comment or planning-doc reference)
- The CHANGELOG entry for the version
- The release commit in `mcp-servers`, via the machine-validated `Release-Gate: <repo-relative-review-path>#<sha256>` trailer stamped by `mcp:release` (see [MCP_OSS_RELEASE_AGENT_DRIVEN](MCP_OSS_RELEASE_AGENT_DRIVEN.md))

### 13.8.1 Residual-risk posture (honest read)

What the §13 gate chain is — and is not:

- **The artifact + gate block + `Release-Gate` commit trailer + Rebel-side trailer audit form an accident/consistency gate, not adversarial security.** An agent or human with push access could forge a trailer or artifact. The public mcp-servers CI validates trailer **format only** (it cannot read `docs-private/` — by design, no secrets on the hardened public repo); the Rebel-side audit verifies the trailer's path + hash against the actual private artifact, closing the gap as far as possible without secrets.
- **The adversarial-security layer is elsewhere**: npm Trusted Publishing (OIDC, no long-lived publish credentials), Sigstore provenance verification (`npm audit signatures` in the release script's verification stage), `.npmrc min-release-age`, and **exact catalog pinning**. A forged npm publish alone does not reach Rebel users — users receive only catalog-pinned versions, so user impact additionally requires the Rebel-side catalog bump to pass its own gates.
- **Publish alerting**: mcp-servers' release.yml — as of its 2026-06-11 publish-alerting change, paired with this revision — posts every npm publish to Slack (connector@version + triggering commit + actor), so an unexpected publish is noticed same-day rather than at next audit.
- **Signed release commits are deferred hardening** (decision 2026-06-11): not built now (key-management overhead vs a 2-maintainer team). Named re-open signals: external-contributor volume growth, any credential-compromise scare, or an OSS-launch readiness review.

### 13.9 What this section deliberately does not do

- **Does not replace** reviewer-side review of contributed PRs at `mindstone/mcp-servers` (see [OPEN_SOURCE_PR_REVIEW_AND_TEST](OPEN_SOURCE_PR_REVIEW_AND_TEST.md)). That gate runs first; this gate runs before our catalog ships the result.
- **Does not replace** runtime monitoring (Sentry, PostHog) or post-incident postmortems. See [MCP_CONNECTOR_WORKFLOW § Critical: Error Observability](MCP_CONNECTOR_WORKFLOW.md#critical-error-observability-for-mcp-operations).
- **Does not exempt** bundled or community connectors — they have their own review obligations under MCP_SERVER_STANDARD and MCP_CONNECTOR_WORKFLOW. § 13 is specifically about OSS-published (`provider: "rebel-oss"`) connectors.

---

## Review History

### Review Round 1 — Septuple Review (2026-04-08)

**Reviewers**: R1 (GPT-5.5), R2 (Opus 4.6 thinking), R3 (GPT-5.3 Codex), R4 (Gemini 3.1 Pro), R5 (Operational lens), R6 (Security lens), R7 (Behavioral safety lens)

**Confidence scores**: R1: 56, R2: 78, R3: 93, R4: 95, R5: 90, R6: 91, R7: 88

**Critical holes identified** (6):
1. Architecture too Slack-shaped — provider capability matrix needed (5/7 consensus)
2. Lazy tokenProvider insufficient alone — cache invalidation required per-connector (3/7)
3. Bridge env var naming wrong in plan (`MCP_HOST_BRIDGE_STATE` vs `MINDSTONE_REBEL_BRIDGE_STATE`) (3/7)
4. Slack redirect URI requires fixed port, breaking dynamic port pattern (3/7)
5. "No env vars → setup instructions" does not exist in current code — connectors crash (3/7)
6. Existing callback servers unsafe as templates — missing state validation, wrong bind address (2/7)

**Estimation challenge**: "~250-300 lines per connector" is an average that obscures 5x variance (100 lines HubSpot → 800 lines Google Workspace).

---

## Maintenance

Update this doc when:
- A new OAuth connector is externalized (update per-connector reality table)
- Provider OAuth requirements change (redirect URI rules, token lifetimes)
- Shared primitives package is created (update section 9)
- Bridge env var naming is standardized (update section 12)
- Security requirements evolve (update section 4)
- Pre-publish review process changes (update section 13 — and update the signposts in [MCP_OSS_CONNECTORS](MCP_OSS_CONNECTORS.md), [MCP_UPDATE_LIFECYCLE](MCP_UPDATE_LIFECYCLE.md), and [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md) if section numbering shifts)
