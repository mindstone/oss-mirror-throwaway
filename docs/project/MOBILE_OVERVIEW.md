---
description: "Rebel Mobile companion app and cloud continuity: architecture, data flow, pairing, and code locations"
last_updated: "2026-06-07"
---

# Rebel Mobile & Cloud Continuity

Rebel Mobile is a React Native companion app that connects to the same cloud-service instance as the desktop app. Cloud continuity is the feature that keeps sessions running in the cloud even when the desktop is closed, and lets the mobile app interact with them. This document explains how the pieces fit together.


## See Also

- [APPROVAL_SYSTEM.md](APPROVAL_SYSTEM.md) -- Approval architecture (shared hooks + mobile bottom sheets + conflict callout)
- [CLOUD_ARCHITECTURE.md](CLOUD_ARCHITECTURE.md) -- Full cloud architecture: routing, deployment, platform abstraction, migration
- [CLOUD_IMPROVEMENT_OPPORTUNITIES.md](CLOUD_IMPROVEMENT_OPPORTUNITIES.md) -- Full prioritized list of known gaps across cloud, mobile, and web
- [MOBILE_PAIRING_AND_AUTH.md](MOBILE_PAIRING_AND_AUTH.md) -- Why mobile uses QR pairing instead of OAuth email sign-in, the BYOK trust model, and the recommended path forward (per-device tokens + opt-in email sign-in)
- [ARCHITECTURE_OVERVIEW.md](ARCHITECTURE_OVERVIEW.md) -- Desktop app architecture
- Planning docs:
  - `docs/plans/obsolete/260218_mobile_companion_app.md` -- Original mobile app plan (screens, code reuse strategy)
  - `docs/plans/obsolete/260304a_local_cloud_continuity.md` -- Local cloud continuity (hybrid local + Fly failover)
  - `docs/plans/260313_cloud_continuity_fly_repair_hardening.md` -- BYOK repair hardening (condensed plan)
  - `docs/plans/partway/260311_multi_cloud_provider_support.md` -- Multi-provider support (Fly, DigitalOcean, Hetzner)
  - `docs/plans/finished/260312_cloud_adopt_existing_instance.md` -- BYOK linking for existing Fly instances


## How It All Connects

```
┌──────────────────────┐                  ┌──────────────────────────┐
│  Desktop (Electron)  │                  │  Mobile (React Native)   │
│  ──────────────────  │                  │  ──────────────────────  │
│  Full UI             │                  │  Companion UI            │
│  Voice pipeline      │    HTTP / WS     │  Approvals, sessions     │
│  Cloud routing ──────┤◄───────────────►├──  Voice input            │
│  Provisioning        │                  │  Push notifications      │
│  BYOK management     │                  │                          │
└──────────┬───────────┘                  └──────────┬───────────────┘
           │                                         │
           │        ┌────────────────────────┐       │
           │        │  Cloud Service (Fly)   │       │
           └───────►│  ──────────────────    │◄──────┘
                    │  Agent execution       │
                    │  Session storage       │
                    │  MCP tools             │
                    │  Workspace files       │
                    │  Push events (WS)      │
                    └────────────────────────┘
```

All three components share the same protocol. The cloud-service is the source of truth when cloud mode is active. Both desktop and mobile talk to it via the same HTTP/WS API, authenticated with the same bearer token (`cloudToken` / `REBEL_CLOUD_TOKEN`).


## Cloud Continuity

Cloud continuity is the per-session setting that determines whether a session stays active in the cloud when the desktop disconnects.

### Continuity States

Each session has a continuity state tracked in `sessions/cloud-continuity-meta.json`:

| State | Meaning |
|-------|---------|
| `local_only` | Default. Session data is synced to cloud for backup but agent execution only happens when the desktop is connected. |
| `cloud_active` | Session runs on the cloud brain. Mobile can see it, send messages, and respond to approvals even when the desktop is offline. |

Users toggle sessions to `cloud_active` via a "Keep in cloud" action. Pinned sessions are exempt from auto-demotion.

### Auto-Demotion

Sessions in `cloud_active` that have been inactive for 14 days (no sync activity) and are not pinned are automatically demoted to `local_only`. A DELETE is enqueued via the cloud outbox to clean up the cloud copy.

### Key Files

| File | Purpose |
|------|---------|
| `src/main/services/cloud/cloudContinuityMetadata.ts` | Per-session state storage (`local_only` / `cloud_active`), pin/unpin, auto-demotion |
| `src/main/services/cloud/cloudSyncMetadata.ts` | Tracks WHEN each session was last synced (separate from WHETHER it should be) |
| `src/main/ipc/cloudHandlers.ts` | IPC handlers for `cloud-continuity:get-state`, `set-state`, `pin`, `unpin`, `get-all` |


## Cloud Sync

Desktop-to-cloud sync is handled by the cloud router's outbox and workspace sync systems.

### Outbox (Desktop -> Cloud)

When cloud mode is active, the cloud outbox queues mutations (session updates, setting changes, workspace writes) and drains them to the cloud service during periodic sync cycles. Failed items are retried with exponential backoff.

### Workspace Sync

Bidirectional incremental sync between desktop workspace files and the cloud volume:

- Desktop is authoritative for conflicts
- Memory content (facts, topics) lives in the workspace directory and syncs automatically
- 5-minute throttle between syncs
- .gitignore patterns respected, symlinks followed (with cycle detection)
- File size limit: < 7MB per file (base64 expansion + cloud body cap)

### Session Sync

Sessions are synced individually via `PUT /api/sessions/:id`. The cloud router's `pullChangedSessions()` method pulls cloud-originated session changes back to the desktop.

### Key Files

| File | Purpose |
|------|---------|
| `src/main/services/cloud/cloudRouter.ts` | Routing decisions, forwarding, sync orchestration |
| `src/main/services/cloud/cloudOutbox.ts` | Queued mutation delivery with retry |
| `src/main/services/cloud/cloudWorkspaceSync.ts` | Bidirectional workspace file sync |
| `src/main/services/cloud/cloudServiceClient.ts` | HTTP/WS client for the cloud protocol |
| `src/main/services/cloud/cloudEventChannel.ts` | Persistent WebSocket for push events (approvals, notifications) |
| `src/shared/cloudChannelPolicies.ts` | Which IPC channels route to cloud |
| `src/shared/cloudSettingsPolicy.ts` | Which settings keys are local-only |


## Mobile App

### Architecture

The mobile app is a React Native (Expo) companion app. It is NOT a standalone product — it requires a desktop installation with cloud mode enabled. The desktop provisions the cloud instance; the mobile app authenticates against the same cloud-service URL.

The mobile app does NOT use `window.api.*` (the Electron IPC surface). Instead, it uses a shared `cloud-client/` package that talks directly to the cloud-service HTTP/WS API.

### Code Reuse

```
src/core/          → Platform-agnostic business logic (types, constants, utilities)
src/shared/        → Shared types (AgentSession, AgentEvent, AppSettings)
cloud-client/      → Shared HTTP/WS client + hooks + stores (used by mobile + web companion)
mobile/            → React Native UI layer
```

The `cloud-client/` package provides:
- `cloudClient.ts` — Platform-agnostic HTTP client (fetch-based, retries, backoff)
- `useEventChannel.ts` — Persistent WebSocket hook for push events
- `useAgentTurn.ts` — Agent turn streaming hook
- `sessionStore.ts`, `approvalStore.ts`, `inboxStore.ts` — Zustand stores over the cloud API
- `createAuthStore.ts` — Authentication state management

### Pairing

Mobile pairs with the cloud instance via QR code or manual entry:

1. Desktop shows a QR code in Cloud settings containing `{ v: 1, type: "rebel-pair", cloudUrl: "https://...", token: "..." }`
2. Mobile scans the QR code (or user enters URL + token manually)
3. Mobile validates the connection by calling `/api/health` then `/api/settings`
4. Credentials stored in secure storage (`mobile/src/storage/secureTokenStorage.ts`)

**Why QR instead of OAuth email sign-in?** See [MOBILE_PAIRING_AND_AUTH.md](MOBILE_PAIRING_AND_AUTH.md) for the full decision: Rebel's cloud is per-user (not multi-tenant), the bearer token is static and instance-scoped, and BYOK users' instances are deliberately unknown to `rebel.mindstone.com`. The QR carries the cloud URL and token that OAuth identity alone cannot provide. That doc also outlines the recommended path to email-based mobile sign-in via per-device tokens + opt-in backend storage.

### Push Notifications

The mobile app subscribes to push events via the cloud-service's persistent WebSocket (`/api/events`). Events include:
- Tool safety approval requests
- Memory write approval requests
- Staged file notifications

Push tokens are registered with the cloud service via `POST /api/push/register`. Registration is **fully guarded against native failures** (`mobile/src/utils/pushNotifications.ts`) — a permission/token rejection from the native layer no longer crashes app startup (REBEL-1CN, commit `3bc13d5d9`).

### Key Files

| File | Purpose |
|------|---------|
| `mobile/src/screens/PairScreen.tsx` | QR code scan + manual pairing |
| `mobile/src/storage/secureTokenStorage.ts` | Secure credential storage |
| `mobile/src/hooks/useApprovalActions.ts` | Approval handling (approve/deny) |
| `mobile/src/components/ApprovalCards.tsx` | Tool + memory approval UI |
| `mobile/src/hooks/useMobileVoiceRecording.ts` | Voice input |
| `cloud-client/src/cloudClient.ts` | Shared HTTP client |
| `cloud-client/src/hooks/useEventChannel.ts` | Shared WebSocket event hook |
| `cloud-client/src/stores/sessionStore.ts` | Session state management |
| `cloud-service/src/routes/push.ts` | Push token registration + delivery |
| `cloud-service/src/routes/events.ts` | WebSocket event broadcast |


### Analytics & error monitoring

Mobile has its own **client-side** telemetry, because its business logic runs on the cloud instance (which already emits core/agent events) — a cloud-side tracker would not capture mobile UI behaviour. Two streams, both identified by email to match desktop:

- **Behavioural analytics** — the RudderStack React Native SDK in `mobile/src/analytics/` (start at `tracking.ts`). Always-on, ~8-12 client/UI-origin events, partitioned so a mobile-driven session is never double-counted against the cloud's core events. Full architecture + rationale: [ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md § Mobile](ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md#mobile-react-native--expo); per-event catalog: [ANALYTICS_DATA_DICTIONARY.md § Mobile](ANALYTICS_DATA_DICTIONARY.md#mobile-events-react-native-client).
- **Error monitoring** — `@sentry/react-native` (`mobile/src/utils/sentry.ts`), with production symbol upload, health context, and the iOS privacy manifest. Details: [ERROR_MONITORING_AND_SENTRY.md § Mobile](ERROR_MONITORING_AND_SENTRY.md#mobile-react-native--expo).

`anonymousId` is the shared `rebel_client_id` (`cloud-client/src/auth/createAuthStore.ts`). App Store / Play privacy declarations (IDFA-free, no ATT prompt) are covered in the two docs above.

## Cloud Provisioning

Users can provision a cloud instance in several ways:

### Auto-Provisioning

The desktop app can automatically create a Fly Machine via the `cloud:provision` IPC handler. This:
1. Validates the user's Fly API token
2. Creates a Fly app with a unique name (`rebel-cloud-XXXXXXXX`)
3. Sets `REBEL_CLOUD_TOKEN` as a Fly secret
4. Creates a persistent volume
5. Launches the machine with the cloud-service Docker image
6. Allocates a shared IPv4 for `*.fly.dev` routing
7. Polls `/api/health` until the service is reachable

### BYOK (Bring Your Own Key) Linking

Users with an existing Fly instance can link their Fly API token via `cloud:link-fly-token`. This validates the token, looks up machine/volume metadata, and persists it for update and repair features.

### Multi-Provider Support

The system supports multiple cloud providers via a `CloudProvider` interface:

| Provider | Status | Infrastructure |
|----------|--------|----------------|
| Fly.io | Production | Fly Machines + persistent volumes |
| DigitalOcean | Available | Droplets + block storage + Cloudflare DNS |
| Hetzner | Available | Cloud servers + volumes + Cloudflare DNS |

Provider implementations live in `src/core/services/cloud/providers/`. The provider registry (`src/core/services/cloud/providers/index.ts`) routes provisioning/deprovision calls to the correct provider.

### Key Files

| File | Purpose |
|------|---------|
| `src/core/services/flyApiClient.ts` | Shared Fly Machines REST + GraphQL API client |
| `src/core/services/flyProvisioningService.ts` | Fly auto-provisioning orchestration |
| `src/core/services/cloudUpdateService.ts` | Cloud image updates + token repair |
| `src/core/services/cloud/providers/types.ts` | CloudProvider interface |
| `src/core/services/cloud/providers/flyProvider.ts` | Fly.io provider adapter |
| `src/core/services/cloud/providers/digitalOceanProvider.ts` | DigitalOcean provider |
| `src/core/services/cloud/providers/hetznerProvider.ts` | Hetzner provider |
| `src/main/ipc/cloudHandlers.ts` | All cloud IPC handlers (provision, link, repair, diagnostics) |
| `src/shared/types/settings.ts` | `CloudInstanceConfig` type definition |


## BYOK Repair & Diagnostics

When BYOK users encounter connectivity issues, the app provides targeted repair tools:

### Connect-Time Verification

The `cloud:link-fly-token` handler verifies reachability and authentication after linking:
- `/api/health` reachable? (catches missing public IPv4)
- `/api/settings` authenticated? (catches missing/wrong token)
- Returns diagnostic fields so the UI can surface specific guidance

### Repair Actions

| IPC Channel | What It Does |
|-------------|-------------|
| `cloud:repair-ingress` | Allocates a shared IPv4 for `*.fly.dev` apps missing public IP |
| `cloud:repair-token` | Writes `REBEL_CLOUD_TOKEN` to machine env (always user-confirmed) |
| `cloud:export-diagnostics` | Exports a redacted diagnostic bundle (local + remote metadata) |

### DNS Error Classification

Network errors are classified beyond the generic `CLOUD_UNREACHABLE`:
- `DNS_CACHE_STALE` — Upstream DNS records exist but local resolver has stale cache
- `DNS_NOT_PROPAGATED` — No upstream DNS records found (instance may be new)

Classification uses `dns.resolve()` (c-ares, bypasses OS cache) vs `getaddrinfo` comparison. Best-effort.

### Key Files

| File | Purpose |
|------|---------|
| `src/core/services/flyApiClient.ts` | `allocateSharedIpv4()`, `updateMachineConfig()`, `listIpAddresses()` |
| `src/core/services/cloudUpdateService.ts` | `repairMachineEnvToken()` |
| `src/main/services/cloud/cloudServiceClient.ts` | DNS error classification |
| `src/main/services/cloud/cloudEventChannel.ts` | `reconnectNow()` for post-repair reconnect |


## CI/CD

### Mobile

> **Releasing or diagnosing a mobile build?** See [RELEASE_TO_MOBILE.md](RELEASE_TO_MOBILE.md) — the runbook for the EAS pipeline (triggers, credentials, watch/diagnose, and the Hermes `import.meta` bundle gotchas).

- `.github/workflows/mobile-preview.yml` ("Mobile TestFlight Deploy") — Auto-triggers on push to `dev` or `main` when `mobile/**`, `cloud-client/**`, or `packages/shared/**` paths change. It deliberately **excludes** `src/core/**` and `src/shared/**` (those land in almost every commit; a core/shared change that needs to reach mobile is shipped via `workflow_dispatch`). Builds production iOS and submits to TestFlight; builds production Android and submits to the Google Play `alpha` track (when `GOOGLE_SERVICE_ACCOUNT_KEY` secret is configured). Also supports `workflow_dispatch`.
- `.github/workflows/mobile-production.yml` ("Mobile Production Deploy") — Manual dispatch only. Builds and submits iOS to TestFlight + Android to Google Play. Accepts a `platform` input (`all`, `ios`, or `android`).
- `.github/workflows/mobile-runtime-integrity.yml` — Runtime integrity checks and mobile unit tests; this is the workflow that triggers on `src/core/**`/`src/shared/**` PRs. It also runs a `production-bundle-smoke` job (a production-mode `expo export`) that catches Node-only / `import.meta` leaks into the RN bundle, which the dev-mode integrity check tolerates but the EAS production build rejects.

### Cloud Service

- Cloud image published to `ghcr.io/mindstone/rebel-cloud` with `prod-<commit>` and `dev-<commit>` tags.
- Auto-update scheduler checks for new images every 24 hours (BYOK instances with linked Fly tokens).
- Admin route (`/api/admin/update`) supports in-place updates via signal file.

See [BUILD_AND_RELEASE_OVERVIEW.md](BUILD_AND_RELEASE_OVERVIEW.md) and [CI_PIPELINE.md](CI_PIPELINE.md) for full details.


## Known Limitations

For the full prioritized list see [CLOUD_IMPROVEMENT_OPPORTUNITIES.md](CLOUD_IMPROVEMENT_OPPORTUNITIES.md). Key mobile-specific limitations:

### Feature surface

The mobile app is a **companion**, not a standalone product. Major desktop surfaces are missing:
- No settings management (must use desktop)
- No workspace/library browser
- No memory/spaces explorer
- No automation manager
- No share-link creation/management (web has this; mobile uses native `Share.share()` on message text only)
- No meeting bot controls

### Session visibility

The conversations screen fetches `activeOnly` sessions (pinned + `cloud_active`). Users **cannot browse or search the full desktop conversation archive** on mobile. Client-side search only filters already-fetched active sessions.

### Offline support

Mobile maintains a modest offline cache for resilience:

- **Session cache**: The 10 most recently viewed conversations are persisted to `AsyncStorage` via MRU eviction (`MAX_CACHED_CONVERSATIONS = 10` in `cloud-client/src/stores/sessionStore.ts`). Cached conversations are readable offline.
- **Offline queue**: Text messages, voice transcriptions, attachments, and meeting chunks queue locally via `cloud-client/src/offlineQueue/OfflineQueue.ts` (payloads stored via `expo-file-system`). The queue **self-rearms** a single retry-drain timer keyed to the earliest pending item (online-only, scope-preserving, with an escalating 10s → 30s → 60s neutral backoff that does **not** count against the retry / permanent-failure taxonomy), and Home / Conversations **pull-to-refresh** also drains the upload queue — so deferred recordings reliably upload even without a reconnect event (REBEL-663, commits `d7b6dc3c6`, `f1b7139f2`). Earlier behaviour drained only "automatically on reconnect", which silently stranded items when no reconnect transition fired.
- **Credentials**: Stored in `expo-secure-store` (Keychain / Android Keystore).
- **Other state**: Inbox, approvals, and non-cached sessions are in-memory Zustand state — app restart = re-fetch for anything outside the 10-conversation cache.

Persistence is wired from `mobile/app/_layout.tsx` → `initPersistence()` + `mobile/src/storage/asyncStoragePersistence.ts`. `mobile/app/_layout.tsx` also wraps **all** layout branches in `GestureHandlerRootView` (not just the happy path), so gesture handlers initialise on every render path (REBEL-170, commit `e8a257c8c`).

### Data fidelity

- REST session responses truncate tool `detail` to 500 chars and drop image content above 10MB/turn
- Live WS events are NOT truncated -- `useAgentTurn` snapshots full mission/task/subagent data on turn completion to mitigate this for active sessions
- Historical sessions loaded from REST have reduced fidelity

### Voice

- **Local STT (Moonshine)**: On-device transcription via `mobile/modules/moonshine-stt/` Expo native module. Uses MoonshineVoice SDK (iOS) / Maven artifact (Android). Model downloaded in Settings tab (~429 MB). Provider toggle enables/disables local mode. Crash containment auto-disables after 3 consecutive process crashes. See [VOICE_AND_AUDIO_LOCAL](VOICE_AND_AUDIO_LOCAL.md).
- **Cloud STT fallback**: When local model not downloaded or user prefers cloud, voice records and uploads to cloud-service for transcription (existing path)
- Voice input is fully buffered (record, transcribe) -- no streaming STT on either path
- TTS playback works but is also fully buffered (no progressive playback)
- Cloud TTS rejects local-only providers -- users configured for `local-parakeet` on desktop lose spoken replies on mobile (but Moonshine works locally on mobile)

### Push notifications

- Push is suppressed when ANY WebSocket client is connected (including a web tab on another device)
- Push scope is limited to: tool/memory approvals, AskUserQuestion, turn completion, turn error
- No pushes for inbox items, workspace conflicts, or sync issues

### Multi-device

- Desktop turns execute locally and sync later (not live shared execution)
- Sessions default to `local_only` -- must be explicitly promoted to `cloud_active` for mobile visibility
- No per-device presence or targeting
- Continuity state propagates on a 60-second cycle (not real-time)

### Security

- WebSocket auth uses URL query params (token in URL) due to React Native WebSocket limitations
- Mobile uses `expo-secure-store` for credentials (secure)
- Web companion uses plaintext `localStorage` (less secure)
