---
description: "Desktop/cloud split architecture, routing, migration, and cloud resilience behavior"
last_updated: "2026-06-18"
---

# Cloud Architecture

Rebel supports offloading its "brain" (agent execution, MCP tools, sessions, settings, workspace) to a cloud instance running on Fly.io, while the desktop Electron app retains the UI, voice pipeline, and OS-level permissions. This document describes how the system splits between local and cloud, how the pieces communicate, and where to find the relevant code.


## See also

- [ARCHITECTURE_OVERVIEW.md](ARCHITECTURE_OVERVIEW.md) -- System architecture for the desktop app; the cloud architecture extends this
- [ARCHITECTURE_IPC.md](ARCHITECTURE_IPC.md) -- IPC contract system; cloud routing intercepts these same channels
- [MCP_ARCHITECTURE.md](MCP_ARCHITECTURE.md) -- MCP and Super-MCP; the cloud service runs its own Super-MCP instance
- [CLOUD_IMPROVEMENT_OPPORTUNITIES.md](CLOUD_IMPROVEMENT_OPPORTUNITIES.md) -- Known gaps, reviewer findings, and prioritized improvement list
- [MOBILE_OVERVIEW.md](MOBILE_OVERVIEW.md) -- Mobile companion app, cloud continuity, pairing, and known mobile limitations
- [MOBILE_PAIRING_AND_AUTH.md](MOBILE_PAIRING_AND_AUTH.md) -- Why mobile uses QR pairing instead of OAuth email sign-in; BYOK trust model; recommended path to per-device tokens
- [SLACK_CLOUD_DEPLOYMENT.md](SLACK_CLOUD_DEPLOYMENT.md) -- Slack cloud app registration, env vars, operator smoke test, and failure-mode runbook
- Planning docs (chronological evolution):
  - `docs/plans/obsolete/260210_cloud_deployment_rebel_to_flyio.md` -- Original feasibility research and IPC channel classification
  - `docs/plans/finished/260213_cloud_deployment_sprites.md` -- Sprites-era approach (superseded)
  - `docs/plans/partway/260214_headless_cloud_service_extraction.md` -- Headless extraction plan (current approach)
  - `docs/plans/finished/260215_cloud_brain_parity.md` -- Full data mirroring design
  - `docs/plans/finished/260218_cloud_primary_architecture.md` -- Cloud-primary pivot (eliminates dual-write)
  - `docs/plans/finished/260218_cloud_phase2_modularize.md` -- Phase 2 modularization
  - `docs/plans/partway/260215_persistent_cloud_event_channel.md` -- Event channel for approval push
  - `docs/plans/finished/260216_cloud_architecture_review.md` -- Architecture review notes
  - `docs/plans/260509_session_event_delta_sync.md` -- Session event delta-sync rollout and invariants
- Key code entry points:
  - `src/core/` -- Platform abstraction layer (6 interfaces)
  - `src/main/services/cloud/` -- Desktop-side cloud routing, client, events, migration
  - `cloud-service/` -- Headless cloud service (HTTP/WS server, bootstrap, routes)
  - *(legacy `cloud-bridge/` has been removed)*
  - `src/shared/cloudChannelPolicies.ts` -- Single source of truth for channel routing
  - `src/shared/cloudSettingsPolicy.ts` -- Settings sync/strip policy


## Key decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Infrastructure | Fly Machines (Docker on Firecracker) | Persistent volumes, always-on (`auto_stop_machines = "off"`, `min_machines_running = 1`) |
| Extraction approach | Build-time electron shim + `src/core/` abstractions | Desktop code untouched; cloud gets stubs for Electron APIs |
| Storage | File-based (JSON files on persistent volume) | Mirrors local storage model, no database |
| Communication protocol | HTTP + WebSocket, Bearer token auth | `cloudServiceClient.ts` handles all HTTP/WS communication with the cloud |
| Source of truth (cloud mode) | Cloud is authoritative, local is write-through cache | Eliminates dual-write divergence; enables future multi-device |

> **Exception — cloud-storage-backed workspace paths (REBEL-696).** The "cloud is authoritative" rule above holds for ordinary workspace paths. For workspace paths that live inside an OS-managed cloud-storage mount (Google Drive / Dropbox / iCloud / OneDrive / Box — i.e. `resolveWorkspaceWriteAuthority(...) === 'desktop_fs_authoritative'`, including through Rebel's per-Space workspace symlinks), the **OS sync engine is authoritative for delivering EXISTING-file edits across devices.** Rebel's desktop pull therefore **defers** those existing-file pulls (records a hash-keyed pending cloud update instead of overwriting in place) rather than co-writing the same path — because two writers on one OS-synced path is precisely what mints the `(1)` conflict-copy loop. **Push (upload) is unchanged**, so phone/web companions keep their read path; only the cloud→desktop write direction is deferred. Genuinely new cloud-only-origin files (which the OS engine never received) are still delivered (the lifeline), via a non-racing atomic write. A mobile/web edit to an existing cloud-backed file — which the OS engine cannot deliver to the desktop — surfaces as a one-click "Newer version available" pending update rather than silent staleness. Detection-general, behaviour-confirmed where spiked (Google Drive + iCloud spiked live 2026-06-19; Dropbox detection-covered; OneDrive/Box detection-covered, not behaviourally spiked). See the write-authority decision tutorial (`docs/tutorials/260606_cloud_sync_write_authority_decision.md`) and `docs/plans/260618_drive-conflict-symlink-loop/PLAN.md`; code spine: `src/main/services/cloud/cloudWorkspaceSync.ts` (pull loop), `src/core/utils/cloudStorageUtils.ts` (`resolveWorkspaceWriteAuthority`).
| MCP in cloud | Own Super-MCP instance in Docker | Full tool access; all transports synced (HTTP, SSE, stdio via npx) |
| Auth token storage (cloud) | Plaintext on Fly persistent volume | Fly volume encryption + Firecracker VM isolation. Relayed from desktop via `cloudAuthRelay` |


## Architecture overview

```
 LOCAL (Electron Desktop App)              CLOUD (Fly Machine)
┌──────────────────────────────┐     ┌────────────────────────────────┐
│  React UI + renderer         │     │  Headless Node.js service      │
│  Voice pipeline (STT/TTS)    │     │  Agent turn execution          │
│  OS permissions (mic, fs)    │ HTTP│  Super-MCP + HTTP MCP servers  │
│  System tray, notifications  │◄───►│  Session persistence           │
│  File picker / drag-drop     │ WS  │  Settings store (canonical)    │
│  Cloud routing layer ────────│─────│  Workspace filesystem (/data)  │
│  Local cache (write-through) │     │  Memory / Spaces               │
│  Cloud settings UI           │     │  Search indexing               │
└──────────────────────────────┘     │  Inbox, automations, tasks     │
                                     └────────────────────────────────┘
```

**What stays local:** UI rendering, voice/audio, OS permissions (mic, file dialogs), system tray, notifications, physical recording hardware, local STT models, cloud management UI.

**What moves to cloud:** Agent execution, MCP tool calls, session storage, settings (canonical), workspace files, memory, search, inbox, automations, user tasks, scratchpad, calendar sync, feedback, community sharing.


## Platform abstraction layer (`src/core/`)

To enable the same business logic to run in both Electron and cloud, Josh extracted 6 platform-agnostic interfaces into `src/core/`. Each follows a "set once at startup, throw if unset" singleton pattern.

| Interface | File | Replaces | Electron impl | Cloud impl |
|-----------|------|----------|---------------|------------|
| `PlatformConfig` | `src/core/platform.ts` | `app.getPath()`, `app.getVersion()`, `app.isPackaged` | `src/main/bootstrap.ts` | `cloud-service/src/bootstrap.ts` (env vars) |
| `HandlerRegistry` | `src/core/handlerRegistry.ts` | `ipcMain.handle()` | `src/main/ipc/utils/ElectronHandlerRegistry.ts` (wraps ipcMain + cloud routing) | `cloud-service/src/mapHandlerRegistry.ts` (plain Map) |
| `BroadcastService` | `src/core/broadcastService.ts` | `BrowserWindow.getAllWindows()` + `webContents.send()` | Electron broadcast impl | `cloud-service/src/cloudEventBroadcaster.ts` (WS push) |
| `StoreFactory` | `src/core/storeFactory.ts` | `new Store()` from `electron-store` | Wraps `electron-store` | `cloud-service/src/electronStoreShim.ts` (JSON file store) |
| `SecureStorage` | `src/core/secureTokenStore.ts` | `safeStorage.encrypt/decrypt` | Electron `safeStorage` wrapper | Not yet wired (plaintext on volume) |
| `EventWindow` | `src/core/types.ts` | `BrowserWindow` type in service signatures | Real `BrowserWindow` | Virtual window via `cloudEventBroadcaster` |

The `StoreFactory` also includes a **write gate** (`src/core/userDataWriteGate.ts`) that makes all store writes no-ops when a newer app version has written data, preventing cross-version corruption. See `docs/plans/partway/260219_global_store_version_gate.md`.


## De-electronification pattern

Services in `src/main/services/` were refactored to replace direct Electron imports with core abstractions:

```typescript
// Before:
import { app } from 'electron';
const userDir = app.getPath('userData');

// After:
import { getPlatformConfig } from '@core/platform';
const userDir = getPlatformConfig().userDataPath;
```

```typescript
// Before:
import { BrowserWindow } from 'electron';
BrowserWindow.getAllWindows().forEach(w => w.webContents.send('event', data));

// After:
import { getBroadcastService } from '@core/broadcastService';
getBroadcastService().sendToAllWindows('event', data);
```

The cloud-service build (`cloud-service/build.mjs`) uses an esbuild plugin (`guardElectronPlugin`) that intercepts any remaining `import { ... } from 'electron'` and replaces them with stubs. Set `REJECT_ELECTRON=1` to make the build fail on any electron imports (useful for auditing de-electronification progress).


## Cloud service (`cloud-service/`)

The headless service that runs on Fly Machines. Built as a single ESM bundle via esbuild.

### Key files

| File | Purpose |
|------|---------|
| `cloud-service/src/server.ts` | HTTP + WS server entry point; route dispatch, CORS, auth, graceful shutdown |
| `cloud-service/src/bootstrap.ts` | Initializes PlatformConfig, wires core interfaces, starts Super-MCP, registers IPC handlers |
| `cloud-service/build.mjs` | esbuild config with electron stub plugin and path aliases |
| `cloud-service/Dockerfile` | Multi-stage build: install deps + build → slim production image |
| `cloud-service/fly.toml` | Fly Machines config: always-on, persistent volume, health checks |
| `cloud-service/src/routes/*.ts` | HTTP/WS route handlers (sessions, settings, agent, library, data, events, etc.) |
| `cloud-service/src/mapHandlerRegistry.ts` | Simple Map-based handler registry for cloud |
| `cloud-service/src/electronStoreShim.ts` | JSON-file-backed store that implements `electron-store` API |
| `cloud-service/src/cloudEventBroadcaster.ts` | Broadcasts events to connected WS clients (replaces BrowserWindow.webContents.send) |
| `src/core/services/continuity/sessionTombstoneStore.ts` | Durable session tombstones (`{ sessionId, deletedAt, deletedBy, ttlExpiresAt }`) with TTL cleanup. Cross-surface; lives in core. |
| `cloud-service/src/auth.ts` | Bearer token validation (constant-time compare) |

### API surface

Routes are consumed by `cloudServiceClient.ts` on the desktop side:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Health check (no auth) |
| GET/PUT/DELETE | `/api/sessions[/:id]` | Session CRUD |
| POST | `/api/sessions/:id/events` | Append-only session event delta push |
| PATCH | `/api/sessions/:id` | Metadata-only session patch |
| GET | `/api/sessions/tombstones?since=<epoch-ms>` | Incremental session-delete tombstone sync (rate-limited per device) |
| GET/PATCH | `/api/settings` | Settings get/update |
| POST | `/api/agent/stop` | Stop agent turn |
| WS | `/api/agent/turn` | Stream agent turn events (includes post-persistence `turn_persisted` ack for idempotent queue drains; see `docs/plans/260418_cloud_continuity_robustness_and_observability.md` Stage 1.1) |
| WS | `/api/events` | Persistent event channel (approvals, push events) |
| POST | `/api/library/{list,read,write}` | Workspace file operations |
| POST | `/api/data/upload-archive` | Streaming tar.gz upload (workspace or appdata) |
| PUT | `/api/mcp/config` | MCP config + OAuth token upload |
| POST/GET/PUT/DELETE | `/api/sessions/:id/share` | Conversation share CRUD |
| POST/GET/PUT/DELETE | `/api/file-shares` | File share CRUD (body-based, paths contain slashes) |
| GET | `/api/shares` | List all shares (conversations + files) |
| GET | `/api/shared/:shareId` | Public shared resource access (no auth) |
| POST | `/api/shared/:shareId/unlock` | Password unlock for shared resource (no auth) |
| GET | `/api/shared/:shareId/download` | File download — streams binary with HMAC-signed URLs for password-protected files (no auth) |
| POST | `/api/ipc/:channel` | Generic IPC forwarding (for any registered handler) |

### Bootstrap flow

1. Set `PlatformConfig` from env vars (`REBEL_USER_DATA` defaults to `/data`)
2. Wire error reporter, store factory, tracker, broadcast service, handler registry
3. Wire settings store adapter
4. Ensure `/data/{sessions,workspace,logs,mcp}` directories exist
5. Set `coreDirectory` to `/data/workspace` if not already set
6. Ensure `super-mcp-router.json` exists, point settings at it
7. Start Super-MCP HTTP server on available port
8. Register IPC handlers (same `register*Handlers()` functions the desktop uses)

### Deployment

- **Docker**: Multi-stage build. Builder stage installs deps + runs `build.mjs`. Production stage copies only `dist/`, `node_modules/`, `super-mcp/`, `rebel-system/`.
- **Fly.io**: Always-on (`auto_stop_machines = "off"`, `min_machines_running = 1`). Legacy wake-on-request code exists for defensive retry but machines are not expected to stop. Persistent volume at `/data`. Health check every 15s.
- **Volume layout**: `/data/sessions/`, `/data/workspace/`, `/data/logs/`, `/data/mcp/`, plus JSON store files.

#### Fly secrets — analytics & error monitoring

Cloud resolves credentials from environment variables (it is `isOss === false`, so `resolveConfigSecret` reads `process.env` directly — no `app-config.json` needed). Set these as Fly secrets (`fly secrets set KEY=value --app <cloud-app>`):

- **`RUDDERSTACK_WRITE_KEY`** + **`RUDDERSTACK_DATA_PLANE_URL`** — required for cloud **product analytics** to emit. Without them, `initAnalytics()` short-circuits with an observable `"missing credentials"` log and `isAvailable()` stays `false`: the analytics feature is inert but **fails observably, not silently** — no crash, no retry storm. (`src/main/analytics.ts` resolves these via `resolveConfigSecret`.)
- **`SENTRY_DSN`** — required for cloud **error monitoring**. Without it, Sentry init is skipped (logged `sentry-disabled`). Optional knobs (honoured via the shared `src/shared/telemetry/sentryConfig.ts` parser): `SENTRY_ENABLED=0` is a kill-switch that disables Sentry even when the DSN is present; `SENTRY_RELEASE` overrides the default `mindstone-rebel-cloud@<version>` release tag; `SENTRY_TRACES_SAMPLE_RATE` overrides cloud's default of `0` (no tracing). `environment` stays the canonical surface filter `'cloud'`.

See [`docs/plans/260612_cloud-analytics-monitoring/PLAN.md`](../plans/260612_cloud-analytics-monitoring/PLAN.md) for the full cloud analytics + Sentry-parity design (surface tagging, owner identify, shutdown flush, RN-import safety).


## Cloud routing (desktop side)

When cloud mode is enabled, the desktop app's IPC layer intercepts calls and routes them to the cloud instance via HTTP/WS.

### Key files

| File | Purpose |
|------|---------|
| `src/main/services/cloud/cloudRouter.ts` | Routing decisions, forwarding, auto-wake, write-through cache |
| `src/main/services/cloud/cloudServiceClient.ts` | HTTP/WS client for the cloud protocol |
| `src/main/services/cloud/cloudEventChannel.ts` | Persistent WS connection for push events (approvals) |
| `src/main/services/cloud/cloudFailureCooldown.ts` | Escalating circuit breaker for repeated cloud failures |
| `src/main/services/cloud/cloudMigrationService.ts` | Data migration pipeline (local → cloud) |
| `src/main/ipc/utils/ElectronHandlerRegistry.ts` | Handler wrapper that enforces cloud routing |
| `src/shared/cloudChannelPolicies.ts` | Single source of truth: which channels route to cloud, dual-write, etc. |
| `src/shared/cloudSettingsPolicy.ts` | Which settings keys are local-only, strip/merge logic |

### Channel routing flow

```
Renderer IPC invoke
  → ElectronHandlerRegistry.register() wrapper
    → cloudRouter.shouldRouteToCloud(channel)?
      YES → forward via HTTP/WS to cloud service
            → on success: run post-cloud hooks (write-through cache for sessions)
            → on failure (non-agent): fall back to local handler
            → on failure (agent:*): no fallback (prevent divergent execution)
      NO  → run local handler as normal
    → cloudRouter.isDualWrite(channel)?  [only settings:update]
      YES → run local handler (for side effects: hotkeys, proxy, workspace watcher)
            → fire-and-forget forward to cloud
```

### Session tombstones (Stage 1.2 continuity hardening)

- Cloud DELETE now writes a tombstone record and broadcasts both `cloud:session-changed` (`deleted`) and `cloud:session-tombstoned`.
- Session read routes filter tombstoned IDs (`GET /api/sessions`, `GET /api/sessions/:id`) so ghost-session resurrection is blocked server-side.
- Mobile/web pull tombstones via `cloud-client.getTombstones(since)` and apply live tombstone events in `sessionStore`.
- Desktop `cloudRouter` tracks a persisted tombstone cursor (`cloudContinuityMetadata.lastSessionTombstoneSyncAt`), applies tombstones on pull, and suppresses tombstoned outbox upserts before push.
- Observability: continuity-state breadcrumbs now include tombstone reasons (`tombstone-added`, `tombstone-applied`, `tombstone-broadcast-received`, `tombstone-race-detected`) with throttled warning escalations for race conditions.

### Server-monotonic ordering (Stage 1.3 continuity hardening)

- Cloud writes stamp `AgentSession.cloudUpdatedAt` via `src/core/services/continuity/serverClock.ts` (never trust client-provided clock values). The stamp is monotonic **per session**, even if host wall-clock moves backwards.
- Persisted events now carry server-stamped per-session `event.seq` values, managed by `src/core/services/continuity/sessionSeqIndex.ts` and persisted as `AgentSession.maxSeq`.
- Session write paths (`/api/sessions/:id`, generic IPC `sessions:*`, and turn persistence in `routes/agent.ts`) all flow through this ordering metadata so reconnect/catch-up can reason about strict ordering.
- Client incremental list fetch uses `cloudUpdatedAt` as an ordering watermark (`modifiedSince`) when present; freshness heuristics still use local `updatedAt` only. Treat `cloudUpdatedAt` as an opaque ordering token, not a wall-clock.
- Backward compatibility: older servers may omit `seq`; clients tolerate this and record a throttled `continuity-state` breadcrumb (`reason: 'seq-unavailable'`).

### Session mutex (Stage 1.4 continuity hardening)

- Core primitive: `src/core/services/sessionMutex.ts` (`withLock(sessionId, ...)`) provides a FIFO async mutex keyed by session ID.
- Cloud mutating paths now lock per session during read-modify-write persistence (`cloud-service/src/routes/sessions.ts`, `cloud-service/src/routes/agent.ts`, `cloud-service/src/routes/continuity.ts`), so concurrent writes to the same session cannot interleave.
- Lock granularity is per session: unrelated sessions continue in parallel.
- **Integrity-first timeout (2026-06-04):** a waiter that exceeds the 5s ceiling fails fast (rejects with `SessionMutexDeadlockError`); **the holder is never forcibly evicted**. The holder keeps its lock until its `fn` settles, so two critical sections can never run concurrently on one key (this replaced an earlier "fail-open" steal that caused a latent lost-update race — see `docs/plans/260604_session-mutex-hardening/`). Trade-off: a genuinely hung holder (a separate bug — `fn` that never settles) stalls *that one* session key until process restart, with every subsequent op failing fast (mapped to 503 at the cloud routes, or logged-degradation / no-op elsewhere). That is intentional: a recoverable stall is safer than silent data interleaving on a session RMW.
- Observability: contention >200ms emits `continuity-state` breadcrumb `session-mutex-contention`; a wait-timeout >5s emits `session-mutex-deadlock` (error-level breadcrumb + Sentry message, no throttle) — the capture names **both** the timed-out waiter (`label`) and the still-holding op (`holderLabel`, `heldMs`, `queueDepth`), so a slow holder is correctly attributed rather than blamed on the waiter. (The `session-mutex-deadlock` name is retained for Sentry-issue continuity though it is really a wait-timeout.) Telemetry emission is best-effort/no-throw — it can never affect lock liveness.
- Atomicity: actual disk writes already use the incremental store's temp-write+rename (`atomically`); the mutex guarantees the merge sequence around those writes.

### Catch-up on reconnect (Stage 1.5 continuity hardening)

- Session delta endpoint: `GET /api/sessions/:id/events?sinceSeq=<n>&limit=<n>` replays seq-ordered events (`seq > sinceSeq`) with `{ events, serverSeq, hasMore }`.
- Multi-session endpoint: `GET /api/continuity/catch-up` supports per-session cursors (`sinceSeq` map) and returns `{ sessions, serverNow, continuationToken? }` with a total page cap (max 5000 events/page).
- Client APIs: `cloud-client.catchUpSession()` and `cloud-client.catchUpContinuity()` auto-paginate through `hasMore` / `continuationToken`.
- `EventBridge` now applies a reconnect barrier: queue live WS events while catch-up runs, apply fetched events under per-session client mutex (`cloud-client/src/utils/sessionMutex.ts`), then flush buffered live events in seq order.
- Idempotency: application path reuses `sessionStore.recordAppliedSeq()` (`applyCatchUpEvents`) so late/duplicate seq values are dropped with continuity breadcrumbs.
- Legacy compatibility: if catch-up endpoints are unavailable (`400`/`404`), client emits `catch-up-unavailable` and releases the barrier (fail-open reconnect UX).
- Observability: catch-up lifecycle breadcrumbs (`catch-up-started`, `catch-up-success`, `catch-up-failed`, `catch-up-unusually-large`); `catch-up-failed` escalates error-level without throttle.
- Cross-session event guard (2026-06-04): the own/foreign/legacy decision for an inbound event is now a single shared SSOT — `classifyEventForSession` in `@rebel/shared`, re-exported by `src/shared/utils/eventSessionValidation.ts` (desktop ingress) and consumed directly by `cloud-client/src/hooks/useUserQuestions.ts` — so the guard logic can no longer drift across desktop and cloud-client. Accepted-legacy batches (events with missing/empty/malformed provenance) are stamped with the caller's `sessionId` rather than leaking a malformed `event.sessionId`.

### Session event delta sync

Desktop sync now prefers `POST /api/sessions/:id/events` for append-only event batches and `PATCH /api/sessions/:id` for metadata-only changes. Capability negotiation is via `X-Rebel-Capabilities`; unsupported or rolled-back clouds fall back to the legacy full-session `PUT /api/sessions/:id` path.

The invariant: push payload size scales with changed events, not total conversation length. The hot-fix safeguards from `82e063515` remain in place permanently — 25MB cap, gzip, 413 permanent-failure classification, and `toolDetailArchive` stripping are belt-and-suspenders, not cleanup fodder.

**Idempotency key must cover the full append body (REBEL-68C, fixed 2026-06-14).** The desktop outbox's idempotency key originally fingerprinted only event *identities*, not the full append body — so a retry that reused the key with a drifted `metadataPatch` / `baseSeq` / message body / tool `uploadStatus` hit the server with the same key but a different payload, which the server rejected as an idempotency mismatch (HTTP 500). Events are **not** immutable across retries, so the key now covers the exact server field set / full body in sent order (commit `b35f7380`). When changing what the outbox sends, keep the key derivation in lockstep with the append body.

Canonical plan and rollout history: `docs/plans/260509_session_event_delta_sync.md`.

### Channel policies (`src/shared/cloudChannelPolicies.ts`)

Single source of truth for routing behavior. Each IPC channel has a policy entry:
- `routable: true` -- channel forwards to cloud when cloud mode is active
- `dualWrite: true` -- run local AND cloud (only `settings:update` currently)
- Derived sets: `CLOUD_ROUTABLE_CHANNELS`, `DUAL_WRITE_CHANNELS`

To add a new cloud-routable channel: add an entry to `CLOUD_CHANNEL_POLICIES` in this file. The router, handler registry, and tests all read from this single table.

### Settings sync

- **Local-only keys** (`cloudInstance`, `coreDirectory`, `mcpConfigFile`): stripped before sending to cloud, merged back from local on reads.
- **`settings:update` dual-write**: local handler runs first (for side effects like hotkey registration, workspace watcher, proxy config), then forwards to cloud.
- See `src/shared/cloudSettingsPolicy.ts` for `stripLocalSettings()` and `mergeLocalSettings()`.


## Resilience and self-healing

Cloud routing uses an escalating circuit breaker to avoid request storms during outages and recover automatically when possible.

Design rule for this layer: any safety gate that can refuse user-visible work indefinitely must be paired with an automatic recovery path — never rely on a manual-only escape that can be deferred.

### Escalating failure cooldown (circuit breaker)

`cloudFailureCooldown.ts` tracks consecutive failures and applies cooldown windows:

- 3 failures → 30s cooldown
- 6 failures → 2m cooldown
- 10 failures → 5m cooldown
- 15 failures → 15m cooldown

Behavior:
- Non-agent channels fast-fail while cooldown is active (`CLOUD_COOLDOWN`) instead of repeatedly hammering a degraded cloud.
- When cooldown expires, one probe is allowed (half-open behavior).
- Any successful cloud call resets the breaker; failures continue escalation.
- State is broadcast to renderer windows via `cloud:circuit-state`.

### Automatic machine recovery

When degradation lasts longer than 5 minutes, `cloudRouter.ts` triggers an auto-recovery check (Fly-backed instances only):

1. Read stored Fly API token
2. Query machine state
3. If machine appears stuck in startup, invoke `cloud:repair-machine`
4. Broadcast machine health updates (`cloud:machine-health`) so UI can surface status

This creates a self-healing path for stuck Fly machines while keeping routing fail-safe when cloud is unavailable.

### Cloud image rollback (defense in depth)

See [`docs/plans/260510_cloud_image_rollback_defense_in_depth.md`](../plans/260510_cloud_image_rollback_defense_in_depth.md) for the full plan and stage breakdown. The contract below is what reviewers must preserve when changing anything in this area; the boundary registry entry `cloud-image-rollback-defense-in-depth` enforces these as Spec Reader invariants.

After a cloud image silently crash-looped in March 2026 (fixed by hot-fix `222189772`), the cloud-service grew a cross-boot recovery contract so a bad image cannot brick a non-technical user's cloud. The contract is layered so each layer fails safe on its own:

1. **Fly `[[restart]]` policy** ([`cloud-service/fly.toml`](../../cloud-service/fly.toml) + [`flyRestartPolicyMigration.ts`](../../cloud-service/src/services/flyRestartPolicyMigration.ts)) caps the crash loop at 5 attempts on existing and new machines. Without this, a deterministic boot crash burns Fly minutes indefinitely.

2. **Boot state machine** ([`bootStateStore.ts`](../../cloud-service/src/services/bootStateStore.ts) + [`bootSuccessMarker.ts`](../../cloud-service/src/services/bootSuccessMarker.ts)) — every boot writes `bootPending: true` to `/data/boot-state.json` at the start and clears it after a 30s grace (override: `REBEL_BOOT_GRACE_MS`). A stuck `bootPending: true` after a fresh process start is the canonical "prior boot crashed silently" signal.

3. **Last-Known-Good image** ([`lastKnownGoodImageTagStore.ts`](../../cloud-service/src/services/lastKnownGoodImageTagStore.ts)) — successful boots stamp the running image tag (with `schemaFingerprint` and `previousLastKnownGood`) into `/data/last-known-good-image.json`. The Dockerfile bakes a `default-lkg.json` for first-boot fallback so the watchdog never has zero history.

4. **Pre-bootstrap watchdog** ([`preBootstrapWatchdog.ts`](../../cloud-service/src/preBootstrapWatchdog.ts) + [`entry.ts`](../../cloud-service/src/entry.ts)) runs BEFORE `server.ts` is imported. The Docker CMD now points at `entry.mjs`, a thin shim that runs the 8-step recovery and then dynamic-imports the real server. The watchdog reads `bootStateStore`, detects a prior crash, and calls `applyImageRollback` with `writerTag: 'watchdog-rollback'` capped at 2 attempts per image lifecycle.

5. **Quarantine list** ([`quarantinedTagsStore.ts`](../../cloud-service/src/services/quarantinedTagsStore.ts)) — tags the watchdog rolled away from land in a 7-day quarantine (TTL override: `REBEL_QUARANTINE_TTL_MS`). The self-update scheduler reads this list before applying a Fly machine config update and skips quarantined tags; manual `triggerImmediateUpdate` returns a structured error so the desktop UI can surface "this tag was rolled back automatically".

6. **`applyImageRollback` chokepoint** ([`src/core/services/flyApiClient.ts`](../../src/core/services/flyApiClient.ts)) — the single function that mutates a Fly machine's image. Every caller passes a `writerTag` (`watchdog-rollback`, `desktop-revert`, `scheduler-update`, `manual-update`) so postmortems can trace which subsystem fired. Direct `PATCH /v1/apps/<app>/machines/<machine>/update` calls outside this helper would bypass the contract; a forbidden_terms regex on the boundary registry catches them.

7. **Schema fingerprint signal** ([`schemaFingerprint.ts`](../../src/core/services/schemaFingerprint.ts)) — the watchdog logs a structured `schema-fingerprint-mismatch` event when the LKG image's fingerprint doesn't match the baked one (`__SCHEMA_FINGERPRINT__`). It still rolls back because the LKG was a known-good boot, but the log gives operators a data-corruption-risk signal to investigate. Future work may upgrade this from log to refuse-on-mismatch once data-migration guarantees are tightened.

8. **Desktop "Try previous version" fallback** ([`desktopLkgCache.ts`](../../src/main/services/cloud/desktopLkgCache.ts) + admin `GET /api/admin/lkg-image` + IPC `cloud:revert-to-last-known-good`) — for failures the watchdog can't detect (e.g. a healthy boot serving wrong data due to schema corruption), the desktop mirrors the cloud's LKG record so the user can manually revert. The IPC is Zod-enforced to require `confirmedByUser: true` so no automation can fire it without an explicit user action.

9. **Forced-crash regression fixture** ([`forcedBootCrash.ts`](../../cloud-service/src/services/forcedBootCrash.ts)) — `REBEL_FORCE_BOOT_CRASH=1` triggers a 100ms-delayed crash after listen, gated by `IS_CI_SMOKE_TEST=1` so it cannot trip in production. The build-cloud workflow's two-container Docker simulation uses this to prove the watchdog detects the prior crash on Boot 2 (see [`.github/workflows/build-cloud.yml`](../../.github/workflows/build-cloud.yml) "Smoke test (rollback path)").

**What reviewers must preserve:**
- Every Fly machine image mutation flows through `applyImageRollback` with a `writerTag`. Never call `machines/<id>/update` directly.
- Every state-file write flows through the canonical store wrapper. Never inline `JSON.stringify` into `boot-state.json`, `last-known-good-image.json`, or `quarantined-tags.json`.
- The watchdog runs BEFORE `server.ts` imports. `entry.ts` must stay a thin shim with no side effects beyond `preBootstrapWatchdog()` + dynamic-import of `server.mjs`.
- The desktop revert handler keeps its `confirmedByUser: true` Zod gate so no automation can rollback without explicit user action.
- The CI smoke step keeps the `[fatal]` stderr scan and the listen-log assertion — those exist because the original hot-fixed bug emitted fatal lines that production didn't surface.

### Cloud error categories and connection reconciler

Typed cloud error category (`src/core/services/cloud/cloudErrorCategory.ts`) provides cross-process consistency for error classification — cloud, renderer, and desktop all reason about the same `CloudErrorCategory` type rather than ad-hoc string matching. See [260504 cloud connection reconciler plan](../plans/260504_cloud_connection_reconciler.md).

`CloudConnectionReconciler` (`src/core/services/cloud/cloudConnectionReconciler.ts`) is the cloud-disconnect recovery state machine. It manages the transition states between connected/disconnected/reconnecting/stuck and surfaces the appropriate UI status. Related plan: [260504 cloud connection reconciler](../plans/260504_cloud_connection_reconciler.md). Related postmortem: [REBEL-568 cloud instance status sticky silent](../../docs-private/postmortems/260504_rebel_568_cloud_instance_status_sticky_silent_postmortem.md).

For `updateConnection` / `disconnect` epoch guards, in-flight pull invalidation, and cloud-startup Codex provider heal, see [CLOUD_CONNECTION_LIFECYCLE.md](CLOUD_CONNECTION_LIFECYCLE.md).


## Cloud migration

When a user first connects to a cloud instance, or manually syncs, the desktop runs a multi-phase migration that streams data from local to cloud.

### Migration phases

| Phase | % range | What happens |
|-------|---------|-------------|
| `settings` | 0-5% | Strip local-only keys, `PATCH /api/settings` |
| `mcp-config` | 5-10% | Resolve MCP router config, upload all servers with OAuth tokens |
| `workspace` | 10-30% | Pre-walk workspace, stream tar.gz (skips .git, node_modules, etc.), upload to cloud |
| `app-data` | 30-50% | Archive userData directory (skip caches, logs, etc.), stream to cloud |
| `sessions` | 50-95% | Upload each session via `PUT /api/sessions/:id` |
| `complete` | 95-100% | Done |

Progress is pushed to the renderer via `cloud:migration-progress` IPC events. Each phase is best-effort (failures recorded, migration continues).

**Entry point:** `src/main/services/cloud/cloudMigrationService.ts` (`migrateToCloud()`)


## Cloud UX

### Settings UI (`CloudTab.tsx`)

- `src/renderer/features/settings/components/tabs/CloudTab.tsx`
- Mode selector: "On this computer" (local) / "In the cloud" (cloud)
- Connect form: Server URL + Access token
- Connection validation: Direct HTTP health check + auth check before persisting
- Status card: Health status, URL, last checked, health/sync/disconnect actions
- Migration progress bar during initial sync

### Cloud mode banner

- `src/renderer/components/CloudModeBanner.tsx (path removed — verify)`
- Subtle banner showing "Cloud mode -- {hostname}" when cloud mode is active

### Instance discovery and conflict resolution

When both a Mindstone-managed instance and a BYOK instance exist simultaneously, the app detects this via `cloud:discover-instances` and surfaces a conflict resolution banner in the Cloud settings tab.
Managed platform endpoints now live under `/api/cloud/managed/*` (replacing the older `/api/auth/electron/cloud/*` namespace); see `src/main/ipc/cloudHandlers.ts` and `src/core/services/cloud/cloudInstanceDiscovery.ts` for the current provision/status/discovery flow.

- `src/core/services/cloud/cloudInstanceDiscovery.ts` — Platform-agnostic discovery: checks managed status API + BYOK health in parallel, returns `DiscoveryResult` with a `conflict` flag
- `src/main/ipc/cloudHandlers.ts` — `cloud:discover-instances` and `cloud:resolve-conflict` IPC handlers; resolution deprovisions the unchosen instance and switches settings
- `src/renderer/features/settings/components/tabs/CloudTab.tsx` — Runs discovery on mount; renders conflict banner with "Use Mindstone Cloud" / "Use {provider}" buttons; handles cleanup warnings when BYOK deprovision fails
- `src/shared/ipc/channels/cloud.ts` — Channel definitions for `cloud:discover-instances`, `cloud:resolve-conflict`, `cloud:switch-provider`

### Provider switching

Users can switch between cloud providers (Fly.io, DigitalOcean, Hetzner, Mindstone-managed) without losing data. The `cloud:switch-provider` handler provisions on the new provider, migrates data, then deprovisions the old one.

- `src/main/ipc/cloudHandlers.ts` — `cloud:switch-provider` handler; `executeSwitchProvider()` orchestrates the non-destructive switch
- `src/renderer/features/settings/components/tabs/CloudTab.tsx` — Provider switch dialog UI with provider picker, token input, and progress display

### Provisioning quit guard

Prevents the user from quitting the app while cloud provisioning or provider-switching is in progress. Shows a native warning dialog with "Quit Anyway" / "Wait" options.

- `src/main/services/cloudProvisioningQuitGuard.ts` — `registerCloudProvisioningQuitHandler()` hooks into `app.on('before-quit')`; checks `isCloudProvisioningActive()` from cloudHandlers
- `src/main/ipc/cloudHandlers.ts` — Exports `isCloudProvisioningActive()` (true while `cloud:provision` or `cloud:switch-provider` is executing)
- `src/main/index.ts` — Registers the quit handler at startup alongside other quit guards


## Known limitations

For the full prioritized list of known gaps, see [CLOUD_IMPROVEMENT_OPPORTUNITIES.md](CLOUD_IMPROVEMENT_OPPORTUNITIES.md). For mobile-specific limitations, see [MOBILE_OVERVIEW.md](MOBILE_OVERVIEW.md#known-limitations). Key architectural limitations:

- **Single-machine architecture**: One always-on Fly machine with one persistent volume. No HA, no horizontal scaling. Volume loss = total data loss without manual backup.
- **Eventual sync, not live sharing**: Desktop turns execute locally and sync to cloud later via outbox. Mobile/web get completed turns, not live streaming from desktop-initiated turns.
- **Sessions default local-only**: Must be explicitly promoted to `cloud_active` for mobile/web visibility. Many desktop sessions are invisible on companion clients.
- **No offline cache on mobile/web**: All stores are in-memory. App restart = full re-fetch.
- **Companion-only mobile/web**: No settings management, workspace browsing, or automation control on mobile or web. These require desktop.
- **Static bearer token**: No rotation, expiry, or revocation. Token compromise = full access. See [MOBILE_PAIRING_AND_AUTH.md](MOBILE_PAIRING_AND_AUTH.md) for the recommended path to per-device tokens (Stage 1) and why we do NOT store BYOK tokens on `rebel.mindstone.com`.
- **Push routing is coarse**: Any connected WS client suppresses mobile push. No per-device targeting.
- **Unpaginated session APIs**: Large session histories scale poorly for mobile/web cold starts.


## Legacy notes

The legacy `cloud-bridge/` directory (Sprites-era proxy) has been removed. The `cloud-service/` is the sole cloud deployment, and `cloudServiceClient.ts` is the sole HTTP/WS client. The env var `REBEL_CLOUD_TOKEN` replaces the old `REBEL_BRIDGE_TOKEN` (the cloud auth module supports both for backward compatibility).


## Persistent event channel

When the agent runs on cloud, approval requests (tool safety, memory writes) need to be pushed to the desktop UI. The **persistent event channel** handles this:

- `src/main/services/cloud/cloudEventChannel.ts` -- Desktop-side WS client
- `cloud-service/src/routes/events.ts` + `cloudEventBroadcaster.ts` -- Cloud-side WS server

Flow:
1. Desktop opens `WS /api/events` on cloud connect
2. Cloud broadcasts events (approval requests) via `cloudEventBroadcaster`
3. Desktop dispatches to renderer via existing IPC channels
4. On reconnect, desktop fetches pending approvals via HTTP catch-up

The event channel has exponential backoff with jitter for reconnection.


## Concurrency

- **Turn concurrency limiter** (`src/core/services/turnConcurrencyLimiter.ts`): Limits concurrent agent turns in both local and cloud modes
- **Single-user model**: Each cloud instance serves one user. No multi-tenant complexity.
- **Multi-device**: Architecturally enabled (cloud is source of truth) but not yet supported. Would need conflict resolution, device presence, and concurrent WebSocket management.


## Deployment

**CRITICAL**: The cloud service bundles into a single `server.mjs` file via esbuild. For code-only changes (routes, handlers, business logic), do NOT use `fly deploy` — it triggers a full Docker image rebuild that takes 10+ minutes and is unnecessary.

### Public sharing

Conversations and library files can be shared via public links with optional password protection and expiry. Share management (create/update/revoke/list) uses authenticated endpoints; public access uses unauthenticated `/api/shared/:shareId` routes. Password-protected file downloads use stateless HMAC-signed URLs via the `REBEL_SHARE_DOWNLOAD_SECRET` environment variable — this must be set on the cloud instance for password-protected file shares to work. See [PUBLIC_SHARING.md](PUBLIC_SHARING.md) for the full sharing architecture.

### Recommended path: push to `dev`, let CI + self-update do the work

The boring, reliable path for any code-only change is:

1. Push to `dev` (with `[deploy-beta]` if you want the desktop beta channel built too — see `coding-agent-instructions/AGENTS.md` § Beta deploy opt-in).
2. `.github/workflows/build-cloud.yml` builds the Docker image and pushes `dev-{sha}` / `dev-latest` to GHCR (~5 minutes).
3. Each cloud instance's `selfUpdateScheduler` notices the new tag within 6 hours (or you can force it via `POST /api/admin/trigger-update`) and calls `updateMachineConfig()` via the Fly Machines API. Fly performs an **in-place image swap** that preserves the existing `/data` volume.

This is the path the production fleet uses. Prefer it over manual deploys.

### Why the sftp shortcut does NOT work on `rebel-cloud-test`

Older versions of this doc described an `fly ssh sftp put → cp /app/... → fly machine restart` shortcut. That shortcut **does not survive restart on this app config**, because:

- `cloud-service/fly.toml` mounts only the `rebel_data` volume at `/data`. `/app` lives on the container's overlayfs (ephemeral).
- `fly machine restart` (and SIGTERM-respawn) starts the init process from a fresh container layer, which discards any `cp` into `/app/...`. The on-disk SHA reverts to whatever was baked into the Docker image at `COPY --from=builder /app/cloud-service/dist/server.mjs ...`.

If you actually want the sftp shortcut to work, you'd need to mount `/app/cloud-service/dist` (or all of `/app`) on a persistent volume — which is **not** how this app is configured today, and changing it would break the immutable-image deploy model that CI relies on. Don't do that.

### Manual code-only deploy (rare — for hot fixes that can't wait for CI)

If CI is broken or you genuinely need to bypass it for a hot fix, the working manual path is an **in-place image swap** using a pre-built image. There is no reliable manual code-only path on this app — pick one of the two below.

**Option A — full `fly deploy` followed by in-place pin (~10 minutes):**

```bash
fly deploy \
  --config cloud-service/fly.toml \
  --dockerfile cloud-service/Dockerfile \
  --remote-only \
  --strategy immediate \
  --build-arg BUILD_COMMIT=$(git rev-parse --short HEAD) \
  --build-arg BUILD_DATE=$(git log -1 --format=%cI)
```

`--strategy immediate` updates the existing machine in place rather than spinning up a new one with a fresh volume. This is critical: the default `bluegreen`/`rolling` strategies provision a NEW volume from the `rebel_data` template, so the existing user data on the old volume is left orphaned. They also transiently run two `started` machines, which the bootstrap self-check (`assertSingleFlyMachineRunning` in `cloud-service/src/bootstrap.ts`) is now relaxed to tolerate (N≥1 started, as long as our own `FLY_MACHINE_ID` is among them — see `docs/plans/260509_session_event_delta_sync.md` Stage 2).

**Option B — push image to GHCR yourself, then `fly machine update`:**

```bash
# 1. Build + push to GHCR (requires `docker login ghcr.io` with a PAT)
docker build -f cloud-service/Dockerfile \
  --build-arg BUILD_COMMIT=$(git rev-parse --short HEAD) \
  --build-arg BUILD_DATE=$(git log -1 --format=%cI) \
  -t ghcr.io/mindstone/rebel-cloud:dev-$(git rev-parse --short HEAD) .
docker push ghcr.io/mindstone/rebel-cloud:dev-$(git rev-parse --short HEAD)

# 2. In-place image swap on the existing machine (preserves /data volume)
MACHINE_ID=$(fly machine list -a rebel-cloud-test --json | python3 -c "import json,sys; print([m['id'] for m in json.load(sys.stdin) if m['state']=='started'][0])")
fly machine update "$MACHINE_ID" -a rebel-cloud-test \
  --image ghcr.io/mindstone/rebel-cloud:dev-$(git rev-parse --short HEAD) \
  --skip-health-checks=false
```

This is what `selfUpdateScheduler` does internally; doing it manually skips the 6-hour poll window.

### Full Docker deploy (only when infrastructure changes)

Use a fresh `fly deploy` (without `--strategy immediate`) only when you need to change:
- Dependencies in `package.json` or `cloud-service/package.json`
- MCP servers (adding/removing/updating bundled or hand-written MCPs)
- Web companion SPA (`web-companion/`)
- Dockerfile itself (base image, system packages, layer structure)
- `rebel-system/` content bundled into the image

```bash
fly deploy --config cloud-service/fly.toml --dockerfile cloud-service/Dockerfile --remote-only
```

Note: Without `--strategy immediate`, this provisions a NEW volume — only safe for fresh apps with no persistent data, OR when you've explicitly arranged data migration first.

### Key files

| File | Purpose |
|------|---------|
| `cloud-service/build.mjs` | esbuild bundler — produces `dist/server.mjs` |
| `cloud-service/Dockerfile` | Multi-stage Docker build (builder + production) |
| `cloud-service/fly.toml` | Fly Machines config (app name, region, VM size, mounts) |
| `.dockerignore` | Excludes `resources/mcp/*/node_modules` (1.45GB) from build context |

### Machine details

**Shared test app (`rebel-cloud-test` via `fly.toml`):**

- App: `rebel-cloud-test` (Fly.io)
- Region: `iad` (US East)
- VM: `performance-2x` with 4GB RAM
- Persistent volume: `rebel_data` mounted at `/data` (10GB initial)
- Always-on: `auto_stop_machines = "off"`, `min_machines_running = 1`
- Health check: `GET /api/health` every 15s

**User-provisioned apps (via `flyProvisioningService.ts`):**

- App: `rebel-cloud-{random}` (Fly.io)
- Region: user-selected (default `iad`)
- VM: user-selected tier (defaults to **Standard**: `shared-cpu-4x` with 4096MB RAM). Other tiers: **Faster** (`performance-cpu-2x`/4096MB) for snappier turns, **Heavy work** (`performance-cpu-4x`/8192MB) for large research/data tasks. Tier definitions live in `src/core/services/cloud/vmTierCatalog.ts`; users can change tier post-provision via Settings → Cloud (handled by `src/core/services/cloud/vmTierService.ts`).
- Persistent volume: `rebel_data` mounted at `/data` (50GB, encrypted)
- Always-on: `auto_stop_machines = "off"`, `min_machines_running = 1`
- Health check: `GET /api/health` every 15s

### VM tier detection — Intent & Design Rationale

> Source of truth: `docs/plans/260529_cloud_vm_sizing_flow.md`. Code: `getTierFromGuest` / `summarizeTierMatch` in `src/core/services/cloud/vmTierCatalog.ts`, consumed by `getCurrentVmTier` (`vmTierService.ts`) and the Settings → Cloud picker (`VmTierSelector.tsx`).

`getTierFromGuest` maps a machine's actual Fly guest config to a catalog tier using **best-fit dominance**: the highest-`speedRank` tier the machine fully dominates on *every* axis (`cpuKind` rank, `cpus`, `memoryMb`), or `undefined` if it dominates none. Two invariants a future change must preserve:

- **Never overstate.** Because the chosen tier is dominated by the machine, its CPU/RAM are each `<=` the machine's actual values — so the UI can never claim more resources than the machine has. A naive "nearest tier" / distance metric was **rejected** because it can snap an upgraded `performance/2/8192` machine to `heavy-work` and falsely advertise 4 vCPUs. Off-grid machines that exceed their best-fit tier are surfaced honestly (e.g. "8 GB now; Faster usually includes 4 GB"); a machine matching no tier shows **no** selected card + a "Custom cloud size" notice (not a fabricated Standard default).
- **Catalog memory is NOT a resource budget.** `cloud-service/src/health/checks.ts` must size the RSS budget from the machine's **actual** `guest.memoryMb`, never from a matched tier's catalog memory. Under the old exact-match these were always equal; under best-fit they are not, so substituting catalog memory would halve the budget on upgraded machines and trip false OOM/pressure. Do not reintroduce a `getTierFromGuest` lookup there.

Tier *detection is read-only*: only an explicit user tier change writes `cloudInstance.vmTierId`. Clicking the current (approx) tier is a deliberate no-op — selecting it would otherwise be a silent downgrade with weak recovery.


## Automated update pipeline (CI → GHCR → Fly)

The cloud service updates itself automatically when new code is pushed. The full chain:

```
Push to dev/main
  → build-cloud.yml (CI: Docker build + smoke test + push to GHCR)
    → selfUpdateScheduler (cloud service: polls GHCR every 6h)
      → updateMachineConfig() (Fly API: swap image + auto-restart)
```

**If any link in this chain breaks, the cloud service stops updating.** The most common failure is `build-cloud.yml` failing to build the Docker image — no new image reaches GHCR, so the self-update scheduler has nothing to pull. Monitor CI failures on this workflow.

### Step 1: CI builds and pushes Docker image

`.github/workflows/build-cloud.yml` triggers on push to `dev` or `main` when cloud-related paths change (see path filters in the workflow). It:

1. Checks out the repo + submodules (needs `REBEL_SYSTEM_TOKEN` secret)
2. Builds the full Docker image (server bundle, web companion SPA, MCP servers, super-mcp, rebel-system)
3. Runs a smoke test (starts container, checks `/api/health`)
4. Pushes to `ghcr.io/mindstone/rebel-cloud` with tags:
   - **`dev` branch**: `dev-{sha}`, `dev-latest`
   - **`main` branch**: `prod-{sha}`, `prod-latest`, `latest`

### Step 2: Self-update scheduler polls GHCR

The cloud service runs a `selfUpdateScheduler` (`cloud-service/src/selfUpdateScheduler.ts`) that:

1. Starts on boot with random jitter (0–30 min) to avoid thundering herd
2. Polls GHCR every **6 hours** for the latest `{channel}-latest` manifest
3. Extracts the commit SHA from the tag and compares against `__BUILD_COMMIT__` (baked in at esbuild time by `cloud-service/build.mjs`)
4. If a newer version exists **and** no agent turns are in progress, proceeds to update
5. On **Fly.io**: calls `updateMachineConfig()` via the Fly Machines API to set the new image; Fly restarts the machine automatically
6. On **self-hosted VM**: writes `.update-signal` + `rebel-cloud.tag` files for the host-level systemd watcher

**Requirements for self-update to work on Fly:**
- `FLY_API_TOKEN` must be set as a **deployed** secret (not just staged — run `fly secrets deploy`)
- `FLY_APP_NAME` and `FLY_MACHINE_ID` are set automatically by the Fly runtime
- `__BUILD_COMMIT__` must be a real commit SHA (not `unknown` — happens in dev/test mode)

### Step 3: Manual triggers

- **Desktop-initiated**: The desktop app can trigger an immediate update via the Cloud settings UI, which calls `POST /api/admin/trigger-update` on the cloud service
- **Admin API**: `POST /api/admin/trigger-update` with optional `{ "channel": "beta" | "stable" }` body — bypasses the 6-hour wait

### Key files

| File | Role |
|------|------|
| `.github/workflows/build-cloud.yml` | CI: Docker build + smoke test + push to GHCR |
| `cloud-service/src/selfUpdateScheduler.ts` | In-process scheduler: polls GHCR, triggers Fly update |
| `src/core/services/cloudUpdateService.ts` | GHCR tag fetching, version comparison logic |
| `src/core/services/flyApiClient.ts` | Fly Machines API client (`updateMachineConfig()`) |
| `cloud-service/src/routes/admin.ts` | Manual trigger endpoint (`/api/admin/trigger-update`) |
| `cloud-service/build.mjs` | esbuild bundler — bakes `__BUILD_COMMIT__` and `__BUILD_DATE__` into the bundle |

### Debugging update failures

1. **CI not building**: Check `build-cloud.yml` runs in GitHub Actions. The web companion SPA Vite build and the bundled MCP build are the most fragile steps. A missing dependency in the Docker build context will block the entire image.
2. **Image built but not picked up**: The scheduler checks every 6 hours with up to 30 min startup jitter. Use `POST /api/admin/trigger-update` to force an immediate check. Verify `__BUILD_COMMIT__` is not `unknown` in the running instance.
3. **Secrets not deployed**: `fly secrets list -a rebel-cloud-test` — if `FLY_API_TOKEN` shows "Staged" instead of "Deployed", run `fly secrets deploy -a rebel-cloud-test`.
4. **Agent turns blocking update**: The scheduler defers if `agentTurnRegistry.getActiveTurnCount() > 0`. Long-running or stuck turns can delay updates indefinitely.
