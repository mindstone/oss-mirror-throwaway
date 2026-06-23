---
description: Rebel's authentication system — OAuth, OTP, guest mode, token management, the RebelAuthProvider boundary, and offline support
last_updated: "2026-06-10"
---

# Authentication

Evergreen reference for Rebel's authentication system: OAuth, OTP, guest mode, token management, and offline support.

## See Also

- [MODEL_AND_PROVIDER_OVERVIEW](MODEL_AND_PROVIDER_OVERVIEW.md) - territory hub; [PROXY_AUTH_BOUNDARY](PROXY_AUTH_BOUNDARY.md) covers per-provider LLM credential injection at the proxy edge, and [MANAGED_PROVIDER_LIFECYCLE](MANAGED_PROVIDER_LIFECYCLE.md) the `/api/config` managed-key flow
- [SYSTEM_ARCHITECTURE](ARCHITECTURE_OVERVIEW.md) - High-level system overview and process boundaries
- [MCP_ARCHITECTURE](MCP_ARCHITECTURE.md) - MCP connector auth patterns (OAuth, API key, bearer token bridge)
- [IPC_ARCHITECTURE](ARCHITECTURE_IPC.md) - IPC contract system for auth handlers
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) - App settings including `REBEL_API_URL`
- [ONBOARDING_SETUP_WIZARD](ONBOARDING_SETUP_WIZARD.md) - How auth integrates with onboarding
- [KEYBOARD_SHORTCUTS](KEYBOARD_SHORTCUTS.md) - Shortcut implementation patterns
- [GIT_WORKTREES § Troubleshooting](GIT_WORKTREES.md#troubleshooting) - "Sign in failed. Please try again." after switching worktrees is usually a version-marker epoch mismatch silently blocking token writes, not an auth bug
- [CLOUD_ARCHITECTURE](CLOUD_ARCHITECTURE.md) - Cross-process auth: cloud sync session event delta, OAuth token exchange across desktop/cloud boundary
- [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md) - Self-hoster-overridable OAuth redirect URIs (`*_REDIRECT_URI` env vars) for connector OAuth flows
- [`docs/plans/260605_oss-auth-removal/PLAN.md`](../plans/260605_oss-auth-removal/PLAN.md) - OSS auth-removal effort (Track B); stage-level detail for the RebelAuthProvider boundary and the OSS NullAuthProvider
- [`docs-private/postmortems/260422_codex_oauth_death_loop_cloud_mobile_parity_postmortem.md`](../../docs-private/postmortems/260422_codex_oauth_death_loop_cloud_mobile_parity_postmortem.md) - Codex/OAuth death loop; cloud/mobile parity issues (2026-04-22)

## Implementation References

- `src/core/rebelAuth.ts` - `RebelAuthProvider` boundary: the single facade consumers call via `getRebelAuthProvider()` (see [The RebelAuthProvider boundary](#the-rebelauthprovider-boundary)). `setRebelAuthProvider(LIVE_AUTH_PROVIDER)` is called once at desktop bootstrap in `src/main/index.ts` with the value resolved from `@private/mindstone/bootstrap`
- `src/core/currentUserProvider.ts` - `getCurrentUserProvider().getCurrentUser()`, the current-user-identity companion to the auth boundary (intentionally kept off `RebelAuthProvider`)
- `src/core/services/privateMindstoneBootstrap.ts` - the typed `PrivateMindstoneBootstrap` contract seam between the OSS core and the commercial (or stub) `@private/mindstone` implementation
- `src/core/services/ossNullAuthProvider.ts` - OSS `OSS_NULL_AUTH_PROVIDER`. **Now wired**: the OSS stub bootstrap (`src/main/oss/private-mindstone-stub/bootstrap.ts`) registers it as `LIVE_AUTH_PROVIDER` (reports `licenseTier: 'teams'`, `isOssBuild: true`, no Mindstone network calls). Distinct from the inert `NULL_REBEL_AUTH_PROVIDER` sentinel in `rebelAuth.ts`
- `private/mindstone/src/services/authService.ts` - Core auth logic (OAuth, OTP, token refresh, heartbeat) for the **commercial** build. Carved out of `src/main/services/` into `private/mindstone/` behind the `RebelAuthProvider` boundary; consumers reach it only through `getRebelAuthProvider()`. In an OSS checkout this tree is stripped and the build resolves to the public stub instead
- `private/mindstone/src/services/desktopRebelAuthProvider.ts` - `DESKTOP_REBEL_AUTH_PROVIDER`, the commercial `RebelAuthProvider` implementation that delegates to `authService`; exported as `LIVE_AUTH_PROVIDER` from `private/mindstone/src/bootstrap.ts`
- `src/main/services/authTokenStorage.ts` - Secure token storage via safeStorage API
- `src/main/services/codexAuthService.ts` - ChatGPT Pro (Codex) OAuth flow; subscription-vs-API-key routing
- `src/core/services/codexTokenStorage.ts` - Secure storage for Codex/OAuth tokens
- `private/mindstone/src/ipc/authHandlers.ts` - Auth IPC handler registration (commercial; carved out of `src/main/ipc/`). OSS stub at `src/main/oss/private-mindstone-stub/ipc/authHandlers.ts`. Registered via `registerPrivateMindstoneHandlers` at bootstrap
- `src/main/ipc/codexHandlers.ts` - IPC handler registration for Codex auth channels
- `src/shared/ipc/channels/auth.ts` - Auth IPC channel definitions
- `src/renderer/features/auth/hooks/useAuth.ts` - React hook for auth state and guest mode
- `src/renderer/features/onboarding/hooks/useEscapeHatchHotkey.ts` - Escape hatch hotkey hook
- `src/renderer/features/auth/` - Login UI components

## Principles & Key Decisions

- **Main process only**: All auth logic lives in main process for security; renderer uses IPC
- **Graceful degradation**: Offline users stay logged in with cached data
- **Conservative logout**: Only 401 errors trigger logout; transient errors preserve session
- **Guest mode**: Hidden escape hatch for local-only usage without authentication
- **One canonical third-party OAuth pattern**: new third-party OAuth integrations follow the HTTPS Cloudflare Worker callback + `mindstone://` deep link pattern — do not add new localhost callback servers for third-party providers

## Architecture Overview

```
┌─────────────────┐     IPC      ┌──────────────────────────────────────────┐
│  Renderer       │ ◄──────────► │  Main Process                              │
│  useAuth hook   │              │  getRebelAuthProvider()  ← @core boundary  │
│  Login UI       │              │    └─ commercial: @private/mindstone       │
└─────────────────┘              │         authService.ts + authHandlers.ts   │
                                 │    └─ OSS stub: OSS_NULL_AUTH_PROVIDER      │
                                 │  authTokenStorage.ts                        │
                                 └───────────────────┬────────────────────────┘
                                                     │ HTTPS (commercial only)
                                                     ▼
                                 ┌─────────────────────────┐
                                 │  Rebel API Server       │
                                 │  rebel.mindstone.com    │
                                 └─────────────────────────┘
```

The OSS build resolves the `@private/mindstone` alias to a public stub (`src/main/oss/private-mindstone-stub/`) via an `existsSync`-guarded vite alias, so it makes no Mindstone network calls.

## The RebelAuthProvider boundary

`src/core/rebelAuth.ts` defines `RebelAuthProvider`, a **single facade** over Rebel/Mindstone auth state: identity / auth state (`getAuthState`, `onAuthStateChange`, `initializeAuth`), access tokens (`getAccessToken`, `invalidateAccessToken`), config presence and license/billing state (`getCachedAuthConfig`, `refreshLicenseTier`, `getSubscriptionState`, `getSharedDriveConfig`, `getManagedAllowanceResetsAt`). Consumers reach auth only through `getRebelAuthProvider()` (and `getCurrentUserProvider()` from `@core/currentUserProvider` for current-user identity, which is intentionally *not* on this facade). A `no-restricted-imports` ESLint guardrail blocks direct `authService` imports outside a small documented allowlist.

**B3 has landed — this is the current architecture, not future groundwork.** The auth implementation no longer lives in `src/main/`. `authService`, the auth IPC handlers, `currentUserProvider`, and the contribution-relay backend were carved out into `private/mindstone/src/` behind the typed `PrivateMindstoneBootstrap` contract seam (`src/core/services/privateMindstoneBootstrap.ts`). `@core` modules never import `@private/mindstone` directly; instead the desktop bootstrap (`src/main/index.ts`) imports `LIVE_AUTH_PROVIDER` (and the other contract members) from `@private/mindstone/bootstrap` and calls `setRebelAuthProvider(LIVE_AUTH_PROVIDER)` once at module-init.

The `@private/mindstone` alias is resolved by an `existsSync`-guarded vite alias (see `vite.main.config.mjs`, `electron.vite.config.ts`, `vitest.config.ts`): if `private/mindstone/src/bootstrap.ts` exists it points at the real commercial tree; if the OSS mirror has stripped it, the alias points at the public stub under `src/main/oss/private-mindstone-stub/`, and the same `existsSync` check drives the renderer's `isOssBuild` signal.

Per-build registration of `LIVE_AUTH_PROVIDER`:

| Build | Registered provider | Notes |
|-------|--------------------|-------|
| Commercial desktop | `DESKTOP_REBEL_AUTH_PROVIDER` (`private/mindstone/src/services/desktopRebelAuthProvider.ts`) | delegates to `authService`; full Mindstone sign-in, OAuth/OTP, heartbeat, license/billing |
| OSS desktop | `OSS_NULL_AUTH_PROVIDER` (`src/core/services/ossNullAuthProvider.ts`) | registered by the stub bootstrap; reports `licenseTier: 'teams'`, `isOssBuild: true`, makes no Mindstone network calls |
| Cloud | inert `NULL_REBEL_AUTH_PROVIDER` sentinel (`rebelAuth.ts`) | no auth IPC channel is cloud-routed yet; a real cloud-bearing provider is still deferred |

**Contribution-sharing UI is gated on OSS.** The connector-contribution surface (`src/renderer/features/settings/components/ConnectorContributionSection.tsx`) returns `null` when `useIsOssBuild()` is true; its backend (`contributionRelayService`, `contributionPublishedEmailService`) lives in `private/mindstone/` and is registered through the core `registerContributionRelayExtension` seam (`src/core/services/contributionRelayExtension.ts`) only by the commercial bootstrap.

**Mindstone sign-in is fully intact for commercial users** — the carve-out moved the code behind the boundary, it did not remove the behaviour. For stage-level history see [`docs/plans/260605_oss-auth-removal/PLAN.md`](../plans/260605_oss-auth-removal/PLAN.md) and [`docs/plans/260607_oss-b6-launch-polish/PLAN.md`](../plans/260607_oss-b6-launch-polish/PLAN.md); this section is the durable summary, not the plan.

### Self-hoster-overridable OAuth redirect URIs

As part of the same effort, the worker-backed connector OAuth flows (Slack, Microsoft, Salesforce, Plaud, GitHub, DigitalOcean, OpenRouter) now resolve their redirect URI at use time from an env override (`SLACK_REDIRECT_URI`, `MICROSOFT_REDIRECT_URI`, etc.; DigitalOcean is `DIGITAL_OCEAN_REDIRECT_URI`), defaulting to `https://rebel-auth.mindstone.com/<connector>/callback`. This lets self-hosters point connector OAuth at their own callback worker. See `src/core/services/oauthRedirectUri.ts`, `.env.example`, and [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md).

## Authentication Modes

### Guest Mode (Escape Hatch)

Hidden shortcut to skip authentication for local-only usage:
- **Hotkey**: `Cmd/Ctrl + Shift + Alt + E` on login screen
- State stored in `sessionStorage` (cleared on app restart)
- `useAuth()` hook exposes `isGuestMode`, `skipAuth()`, `exitGuestMode()`
- No API calls requiring auth will work; local features only
- Same escape hatch available during onboarding for permissions step

### OAuth Flow (Google/Microsoft)

1. Generate PKCE challenge (`state`, `code_verifier`, `code_challenge`)
2. Start loopback HTTP server on `127.0.0.1` (dynamic port)
3. Open system browser to OAuth provider
4. Receive `exchange_token` at `/callback`
5. POST to `/api/auth/electron/exchange` with code verifier
6. Call `completeLogin()` - save token, fetch user, start heartbeat

#### Network Connectivity Checks

On login screen mount, two connectivity checks run in parallel:

| Check | What it does | Timeout | Detects |
|-------|--------------|---------|---------|
| **Loopback** | Creates temp HTTP server on `127.0.0.1`, fetches from it | 500ms | Enterprise tools (Zscaler) blocking localhost |
| **API Reachability** | POST to `/api/ping` | 6s | Corporate proxies/DLP blocking POST requests |

**Behavior matrix:**

| Scenario | Google/Microsoft | Email OTP | Warning | Recovery |
|----------|------------------|-----------|---------|----------|
| Both working | Enabled | Available | None | - |
| Loopback blocked | Disabled | Auto-shown | "Something is blocking sign-in with Google and Microsoft..." | Use OTP |
| API unreachable | Enabled | Available | "Unable to connect to Rebel..." + IT hint | Polls `/api/ping` every 5s until recovered |
| Both blocked | Disabled | Auto-shown | API warning (priority) | Polls every 5s |

**IPC channels:**
- `auth:test-loopback` - returns `true` if loopback works
- `auth:test-api-reachability` - returns `true` if API reachable via POST

**TLS fallback:** If the API reachability check fails with a TLS error (e.g., corporate SSL inspection proxy), it automatically retries via Electron's `net.fetch()` (Chromium network stack) on **all platforms**. This handles edge cases where native Node.js CA loading doesn't fully cover the system cert store. See `classifyApiReachabilityError()` and the TLS retry path in `private/mindstone/src/services/authService.ts`, and [WINDOWS_SUPPORT § TLS Certificate Trust](WINDOWS_SUPPORT.md#tls-certificate-trust) for the broader TLS strategy.

**Implementation:** `testLoopbackConnectivity()` and `testApiReachability()` in `private/mindstone/src/services/authService.ts`

#### Testing Network Scenarios (macOS)

**Simulate loopback blocked:**
```bash
# Block loopback (allow port 5173 for dev server)
(cat /etc/pf.conf; echo "pass quick on lo0 proto tcp from any to 127.0.0.1 port 5173"; echo "block drop quick on lo0 proto tcp from any to 127.0.0.1") | sudo pfctl -f -
sudo pfctl -e

# Restore
(cat /etc/pf.conf) | sudo pfctl -f -
```

**Simulate API blocked:**
```bash
# Block
sudo sh -c 'echo "127.0.0.1 rebel.mindstone.com" >> /etc/hosts'

# Restore
sudo sed -i '' '/rebel.mindstone.com/d' /etc/hosts
```

**Simulate offline:** Disable Wi-Fi or use airplane mode.

### OTP Flow (Email Code)

1. `POST /api/auth/electron/otp/send` with email address
2. User enters 6-digit code from email
3. `POST /api/auth/electron/otp/verify` with email + code
4. Call `completeLogin()` - save token, fetch user, start heartbeat

### ChatGPT Pro (Codex) Auth Flow

Rebel supports authentication via ChatGPT Pro subscription in addition to direct API keys. This path uses the `codexAuth` boundary to bridge between the subscription-based ChatGPT Pro session and Rebel's token management.

**Two authentication paths (kept distinct as separate profiles, never merged):**

| Path | How it works | Use when |
|------|-------------|---------|
| **ChatGPT Pro subscription** | OAuth against the ChatGPT Pro session → token persisted via `codexTokenStorage` and resolved per turn by `codexAuth` | User has a ChatGPT Pro subscription |
| **Direct API key** | Per-profile `apiKey` (model-profile `profile.apiKey`, `customProvider.apiKey`, or the shared `providerKeys[providerType]` map) | User configures explicit API credentials for the provider |

**`codexAuth` boundary:** The `codexAuth` system (implemented in `src/main/services/codexAuthService.ts` and `src/core/services/codexTokenStorage.ts`) mediates the ChatGPT Pro side. Direct-API-key routing is independent — see `src/shared/utils/providerKeys.ts` (per-profile key resolution) and `src/core/rebelCore/clientFactory.ts` (routes the resolved auth context to the correct `ModelClient`). A Codex subscription profile does **not** silently fall back to a shared OpenAI API key if the OAuth session is unavailable; the two paths are kept as separate profiles by design.

**OAuth implementation:** The ChatGPT Pro OAuth flow is implemented in `src/main/services/codexAuthService.ts` (main process entry) with IPC handlers in `src/main/ipc/codexHandlers.ts`. Tokens are stored securely via `src/core/services/codexTokenStorage.ts`. Cross-process auth coordination (desktop ↔ cloud) is described in [CLOUD_ARCHITECTURE](CLOUD_ARCHITECTURE.md).

**BTS Codex-connected guards:** When Behind the Scenes uses a Codex-connected profile, the `callWithModelAuthAware` wrapper in `behindTheScenesClient.ts` checks `ModelAuthAware` and applies cooldown bypass logic based on auth state. See `docs-private/postmortems/260429_bts_callwithmodelauthaware_cooldown_bypass_postmortem.md` for the cooldown bypass bug (2026-04-29).

## Token Management

| Token | Lifetime | Storage | Purpose |
|-------|----------|---------|---------|
| Session token | Long-lived (server-controlled) | Encrypted via `safeStorage` (OS keychain) | Exchange for JWT |
| JWT access token | Short-lived (~15-60 min) | In-memory only | API authentication |

### Heartbeat & JWT Refresh

- Background interval runs every 60 seconds
- Calls `getAccessToken()` which refreshes JWT if < 5 min remaining
- POSTs to `/api/heartbeat` (fire-and-forget) with platform/version
- Silently fails on network errors

### Logout Triggers

Users are logged out **only** when:
1. User explicitly calls logout
2. JWT refresh returns HTTP 401

**Not** logged out on: network errors, 500s, timeouts (offline support)

## IPC Channels

| Channel | Description |
|---------|-------------|
| `auth:get-state` | Get current auth state |
| `auth:login` | Initiate OAuth flow |
| `auth:logout` | Sign out current user |
| `auth:get-user` | Get current user info |
| `auth:get-access-token` | Get valid JWT (refreshes if needed) |
| `auth:cancel` | Cancel pending OAuth flow |
| `auth:send-otp` | Send OTP code to email |
| `auth:verify-otp` | Verify OTP and complete login |
| `auth:test-loopback` | Test if loopback connectivity works for OAuth |

Push events: `auth:state-changed`, `auth:login-error`

## Offline Support

- Cached user info used for UI
- Cached JWT returned if still valid  
- Heartbeat silently fails
- Session may expire server-side; 401 on reconnect triggers logout

## Known Limitations

1. **Non-401 JWT failures**: User stays "authenticated" but API calls fail
2. **No degraded state UI**: No visual warning when auth is degraded
3. **Guest mode persistence**: Cleared on app restart (sessionStorage)
4. **Login network errors**: If `fetchUserInfo()` fails due to a transient network error (not 401) during `completeLogin()`, the login fails completely even though the session token may be valid. User must re-authenticate.

## Security Considerations

- Session tokens encrypted at rest via OS keychain (macOS Keychain, Windows Credential Manager)
- PKCE prevents authorization code interception
- Loopback server validates `state` parameter
- JWT never stored on disk
