---
description: "How Claude Max OAuth tokens are acquired, stored, refreshed, and synced across desktop, cloud, and mobile"
last_updated: "2026-06-21"
status: historical
---

# Claude Max OAuth Authentication

> **⚠️ DEPRECATED (April 2026) — read before trusting this doc.** The user-facing Claude Max
> OAuth flow has been removed: the setup/storage services this doc describes
> (`claudeMaxSetupService.ts`, `claudeMaxTokenStorage.ts`) **no longer exist**, and the live auth
> path emits only `ANTHROPIC_API_KEY` (see `src/core/utils/authEnvUtils.ts`). Some `oauth-token`
> plumbing may still survive (e.g. the `oauth-token` arm of `providerAuthPlan.ts` and
> `CLAUDE_CODE_OAUTH_TOKEN`); whether it is genuinely live or zombie code is **not** resolved here
> — verify against the code before relying on it. This doc is retained as **historical reference**
> for the original design; do not treat its lifecycle/refresh/sync narrative as current behaviour.
> For current auth see [AUTHENTICATION](./AUTHENTICATION.md) and the territory hub
> [MODEL_AND_PROVIDER_OVERVIEW](./MODEL_AND_PROVIDER_OVERVIEW.md). Auditing/removing the residual
> OAuth code is a tracked follow-up (see the model/provider refactor backlog).

> **🏷️ Availability note (2026-06-21) — the underlying offer is probably gone for third-party apps.**
> Anthropic's Claude Max "almost all-you-can-eat" fixed-fee subscription is **probably no longer
> available to third-party apps** like Rebel (the terms that let an app authenticate an end user's own
> Max subscription and ride its fixed-fee allowance appear to have closed). This is the *business* reason
> behind the code removal above. **We are deliberately NOT deleting the residual OAuth code yet** — it is
> kept dormant in case Anthropic reopens third-party Max access, at which point the keep-vs-delete
> decision should be revisited. Until then, do not invest in this path; treat Claude Max as unavailable
> for new work.

Developer-facing reference for how Claude Max OAuth token auth works in Rebel across desktop, cloud, and mobile.

## See also

- [AUTHENTICATION.md](AUTHENTICATION.md) — broader auth architecture and token patterns
- [CLOUD_ARCHITECTURE.md](CLOUD_ARCHITECTURE.md) — desktop/cloud split and storage model
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) — settings model and persistence

## Overview

Claude Max OAuth is **desktop-initiated, cloud-assisted, and mobile-consumed indirectly**:

- **Desktop (Electron)** is the only place that can start the Claude Max OAuth PKCE flow.
- **Cloud** reuses the same refresh logic so it can keep tokens fresh for cloud-executed work.
- **Mobile** does not talk to Claude Max directly; it authenticates to Rebel's cloud service, which uses the synced Claude Max credentials on the user's behalf.

Rebel intentionally writes Claude Max token data to **two places** on desktop:

1. **Desktop token store** via `claudeMaxTokenStorage.ts` for local persistence
2. **`settings.claude.*`** so refresh metadata can sync to cloud

That second copy is important for continuity, but it also means the refresh token is **not confined to desktop-only secure storage**.

## Desktop Flow

Desktop owns the interactive OAuth flow in `src/main/services/claudeMaxSetupService.ts`.

1. `setupClaudeMaxToken()` starts the OAuth PKCE flow.
2. The browser-based auth completes and returns an access token, optional refresh token, and expiry.
3. Rebel writes:
   - `settings.claude.oauthToken`
   - `settings.claude.oauthRefreshToken`
   - `settings.claude.oauthTokenExpiresAt`
   - `settings.claude.authMethod = 'oauth-token'`
4. Rebel also saves the full token set via `claudeMaxTokenStorage.ts`.
5. When auth env vars are needed, `getAuthEnvVars()` maps `settings.claude.oauthToken` to `CLAUDE_CODE_OAUTH_TOKEN` for Rebel Core's Anthropic API calls.

Desktop also refreshes proactively:
- `ensureClaudeMaxTokenFresh()` runs before agent turns
- the same hook is registered for behind-the-scenes OAuth calls

## Cloud/Mobile Flow

Cloud imports the same Claude Max setup/refresh service, but it only uses the **refresh** side of it.

- `cloud-service/src/bootstrap.ts` registers `ensureClaudeMaxTokenFresh()` as a pre-OAuth-call hook.
- Cloud **cannot initiate** the OAuth PKCE login flow itself; that requires the desktop browser + loopback callback flow.
- Instead, cloud relies on the Claude Max tokens that were first created on desktop and then synced through settings.

Mobile has no Claude Max token management of its own:

- mobile authenticates to the cloud service with the Rebel cloud bearer token
- cloud performs Claude-authenticated work using the synced Claude Max credentials
- if the user has never connected Claude Max on desktop, mobile cannot bootstrap it

## Token Lifecycle

```text
Desktop OAuth connect
  -> setupClaudeMaxToken()
  -> write tokens to settings + desktop token store
  -> sync settings to cloud

Before Claude-authenticated work
  -> ensureClaudeMaxTokenFresh()
  -> if expiry is more than 5 minutes away: use current token
  -> if expiring soon: refresh via refresh_token grant

Refresh success
  -> save new access token / refresh token / expiry
  -> update settings again
  -> broadcast settings refresh

Refresh failure
  -> 400/401: clear Claude Max tokens from storage + settings
  -> transient errors: keep existing tokens and retry later
```

Important behavior:

- Rebel stores an absolute `oauthTokenExpiresAt` timestamp and refreshes when the token is within a 5-minute buffer.
- `refreshClaudeMaxToken()` uses `loadClaudeMaxTokensWithFallback()`. That loader prefers the local token store when available, then falls back to `settings.claude.oauthToken`, `oauthRefreshToken`, and `oauthTokenExpiresAt`.
- Concurrent callers share a single in-flight refresh via `pendingRefreshPromise` (prevents duplicate token exchanges within a process, but not across desktop and cloud processes).
- The refresh grant hits `https://platform.claude.com/v1/oauth/token` (`ANTHROPIC_TOKEN_URL` constant).
- On revocation clearing, `authMethod` stays as `'oauth-token'` with null credentials. `getAuthEnvVars()` handles this gracefully (falls through to API key if present).
- Claude Max OAuth is entirely separate from Rebel user authentication (Google/Microsoft/OTP). The two auth lifecycles do not interact.

## Settings Sync

Claude Max continuity across desktop and cloud depends on settings sync.

`src/shared/cloudChannelPolicies.ts` marks `settings:update` as a **dual-write** channel. That is the mechanism that propagates Claude Max refresh metadata to the cloud copy of settings.

Why this matters:

- desktop can complete the OAuth flow once
- cloud later receives the synced refresh token and expiry metadata
- cloud can refresh tokens for mobile/web-triggered work without re-running the browser flow

## Disconnect

Disconnecting Claude Max happens via settings update (clearing `oauthToken` to null), which propagates to cloud via the dual-write `settings:update` channel. The encrypted desktop token store (`clearClaudeMaxTokens()`) is only cleared on refresh failure, not on manual disconnect.

## Cross-process refresh race (mitigated)

Anthropic uses refresh token rotation (RFC 9700) — when a refresh token is redeemed, it's invalidated and a new one is issued. Desktop and cloud are separate processes sharing refresh metadata via settings sync. Three guardrails prevent the rotation race from forcing user reconnection:

1. **Asymmetric timing (Guardrail 2):** Desktop refreshes 5 minutes before expiry; cloud refreshes only 30 seconds before. This 4.5-minute gap ensures desktop almost always refreshes first, syncs new tokens to cloud, and cloud picks them up without needing to refresh. Cloud's buffer is set via `CLOUD_TOKEN_REFRESH_BUFFER_MS` in `bootstrap.ts`.

2. **Re-read before refresh (Guardrail 3):** Inside `refreshClaudeMaxToken()`, tokens are re-read from storage/settings immediately before sending the refresh request. If the other process already refreshed and synced, the refresh is skipped entirely.

3. **Retry before clear (Guardrail 1):** On `400 invalid_grant`, instead of immediately clearing tokens, the code waits 2 seconds for settings sync propagation, then re-reads tokens. If the token tuple changed (other process won the race), it adopts the winner's tokens or retries once with the new refresh token. Only clears tokens if no recovery is possible. **Note:** This primarily helps cloud-as-loser (where desktop's tokens propagate via dual-write). Desktop-as-loser cannot recover via settings re-read because settings sync is one-way (desktop→cloud).

**Remaining limitation:** If desktop is offline for the entire token lifetime and cloud refreshes, desktop cannot receive cloud's new tokens (no cloud→desktop settings push). Desktop will clear tokens on next launch, requiring user reconnection. This is acceptable given the asymmetric timing makes it rare, and the deferred `setup-token` approach (see `docs/plans/260330_claude_max_setup_token_long_lived.md`) eliminates refresh entirely.

See `docs/plans/260330_claude_max_refresh_rotation_hardening.md` for full design rationale and edge case analysis.

## Security note

The refresh token is duplicated into `settings.claude.oauthRefreshToken` so it can sync to cloud. That is an intentional tradeoff for cross-device continuity, but it means the refresh token exists outside desktop-only secure storage. Treat the synced settings store as sensitive.

## Architecture sketch

```text
┌──────────────────────── Desktop (Electron) ────────────────────────┐
│ setupClaudeMaxToken()                                              │
│   -> OAuth PKCE in browser                                         │
│   -> save full token set locally                                   │
│   -> write oauthToken / oauthRefreshToken / expiresAt to settings  │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ settings:update (dual-write)
                               ▼
┌───────────────────────── Cloud service ────────────────────────────┐
│ ensureClaudeMaxTokenFresh()                                        │
│   -> loadClaudeMaxTokensWithFallback()                             │
│   -> refresh via synced refresh token when needed                  │
│   -> use CLAUDE_CODE_OAUTH_TOKEN for cloud-side Claude calls       │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ bearer-authenticated Rebel requests
                               ▼
                        Mobile / web clients
                  (no Claude Max OAuth flow of their own)
```

## Key Files

- `src/main/services/claudeMaxSetupService.ts` — OAuth setup, refresh, fallback loading, and `ensureClaudeMaxTokenFresh()`
- `src/main/services/claudeMaxTokenStorage.ts` — desktop token persistence; `safeStorage`-backed when available
- `src/core/utils/authEnvUtils.ts` — maps `settings.claude.oauthToken` to `CLAUDE_CODE_OAUTH_TOKEN`
- `src/main/services/agentTurnExecutor.ts` — refreshes OAuth token before Claude-authenticated turns
- `src/core/services/behindTheScenesClient.ts` — pre-OAuth-call hook for BTS/background Claude calls
- `cloud-service/src/bootstrap.ts` — registers the cloud pre-call refresh hook
- `src/shared/types/settings.ts` — defines `oauthToken`, `oauthRefreshToken`, and `oauthTokenExpiresAt`
- `src/shared/cloudChannelPolicies.ts` — marks `settings:update` as dual-write for cloud sync
- `src/main/ipc/claudeMaxHandlers.ts` — IPC handler wiring `claudeMax:setup-token` to `setupClaudeMaxToken()`
- `src/shared/ipc/channels/claudeMax.ts` — IPC channel definitions (setup + cancel)
