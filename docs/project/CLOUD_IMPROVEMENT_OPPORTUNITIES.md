---
description: "Living backlog of cloud, mobile, and web architecture gaps — infrastructure, sync, security, monitoring, prioritised fixes"
last_updated: "2026-06-18"
---

# Cloud Improvement Opportunities

Known gaps, reviewer findings, and prioritized improvements for the cloud/mobile/web architecture. This is a living document -- update it as items are addressed or new issues are discovered.


## See also

- [CLOUD_ARCHITECTURE.md](CLOUD_ARCHITECTURE.md) -- Main cloud architecture documentation
- [MOBILE_OVERVIEW.md](MOBILE_OVERVIEW.md) -- Mobile app and cloud continuity architecture
- Planning docs in `docs/plans/` -- Design decisions and implementation history
- `src/main/services/cloud/` -- Desktop-side cloud code
- `cloud-service/` -- Headless cloud service
- `cloud-client/` -- Shared cloud client (mobile + web)
- `mobile/` -- React Native companion app
- `web-companion/` -- Web companion SPA
- `src/shared/cloudChannelPolicies.ts` -- Channel routing policies


## Source

- **Original findings (2026-02-20):** Multi-model review using GPT-5.3 Codex, Gemini 3.1 Pro, GLM-5, and Kimi K2.5.
- **Updated (2026-03-30):** Deep code analysis using GPT-5.5 + manual codebase review. Added mobile/web gap categories, marked resolved items, added new findings.


---


## Cloud Service Infrastructure

### 1. Cloud-service bootstrap dependency wiring drift (P0)
**Source:** GPT-5.3 Codex (Feb 2026)
**Location:** `cloud-service/src/bootstrap.ts` (`registerCloudIpcHandlers()`)
**Issue:** Several `register*Handlers(...)` calls may pass incomplete or wrong dependency shapes versus the handler contracts in `src/main/ipc/*Handlers.ts`. Type mismatches surface as runtime `HANDLER_ERROR` rather than compile-time failures.
**Impact:** Cloud IPC requests can fail silently, causing cloud/local divergence.
**Fix:** Add a cloud bootstrap contract test that verifies each registered handler receives required deps and can execute a smoke call.

### 2. Agent turn WS listener lifecycle leak (P0)
**Source:** GPT-5.3 Codex (Feb 2026)
**Location:** `cloud-service/src/routes/agent.ts`
**Issue:** `deps.setEventListener(turnId, ...)` is called but cleanup on WS close only aborts the controller -- it does not remove the event listener entry from `agentTurnRegistry`.
**Impact:** Long-running cloud instances accumulate orphaned listeners when sockets close before terminal events arrive.
**Fix:** Add `agentTurnRegistry.removeEventListener(turnId)` (or equivalent cleanup) in the WS close handler.

### 3. Single-machine, single-volume architecture (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `cloud-service/fly.toml`, `cloud-service/src/electronStoreShim.ts`, `cloud-service/src/pushStore.ts`
**Issue:** Fly config keeps exactly one always-on machine with one `/data` volume. All state is file-backed (JSON stores, session files, push tokens). No HA, no failover, no horizontal scaling path.
**Impact:** Single point of failure. Volume loss = total data loss. Scaling requires architectural rework.
**Fix:** Long-term: move to database-backed storage (SQLite or Postgres). Short-term: automated volume snapshots.

### 4. API + web companion share the same process and connection budget (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `cloud-service/src/server.ts`, `cloud-service/fly.toml` (soft/hard limits: 20/25 connections)
**Issue:** The cloud server serves `/app` (web companion SPA) and all API/WS endpoints from one Node.js process. Web asset traffic competes with agent turns, uploads, and event sockets.
**Impact:** Heavy web companion usage can starve API connections.
**Fix:** Serve web companion from CDN/separate origin, or increase connection limits.

### 5. Session APIs are unpaginated (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `cloud-client/src/cloudClient.ts`, `cloud-service/src/routes/sessions.ts`
**Issue:** `getSessions()` only supports `activeOnly` and `modifiedSince` filters. Returns all matching sessions in one response. Full session fetch loads entire lean transcript + tool-event payload.
**Impact:** Large histories will hurt cold-start latency and memory on mobile/web. Scales poorly as users accumulate hundreds of sessions.
**Fix:** Add cursor-based pagination to session list and consider lazy-loading for full session content.

### 6. Voice endpoints are fully buffered and unbounded (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `cloud-service/src/routes/voice.ts`
**Issue:** `/api/voice/transcribe` writes the full request to `/tmp`, then reads the entire file into memory. Server request timeouts are disabled globally. TTS response concatenates full audio stream and returns base64 JSON.
**Impact:** Large uploads spike latency/memory. No progressive playback. Potential DoS vector.
**Fix:** Add request body size limits, streaming transcription, and chunked TTS delivery.

### 7. Health check is shallow (P1)
**Source:** Kimi K2.5, GLM-5 (Feb 2026)
**Location:** `cloud-service/src/server.ts`
**Issue:** `/api/health` returns static `{ status: 'ok' }` without checking Super-MCP health, disk space, or critical service readiness.
**Fix:** Add deep health check that verifies MCP responsiveness and volume access.

### 8. No automated backup of persistent volume (P1)
**Source:** Kimi K2.5 (Feb 2026)
**Issue:** Fly.io volumes survive machine failures but not accidental deletion or corruption. No backup/export mechanism exists.
**Fix:** Periodic volume snapshots via Fly.io API, or scheduled export-to-cloud-storage.

### 9. No structured metrics or monitoring (P2)
**Source:** Kimi K2.5 (Feb 2026)
**Issue:** No Prometheus/statsd integration. Operational visibility requires reading logs. `/api/diagnostics` returns coarse checks + last 60s logs but no route metrics, outbox/workspace sync state, or push delivery stats.
**Fix:** Add `/api/metrics` endpoint with request counts, latencies, error rates, active turns, MCP health.
**Session-sync note (2026-05-10):** Stage 8 of `docs/plans/260509_session_event_delta_sync.md` added continuity breadcrumbs and payload histograms for delta sync. Until first-class metrics land, monitor `session-delta-push:*`, `delta_push_response_size`, desktop payload histograms, 413/BODY_TOO_LARGE counts, and oversized ledger/skipset breadcrumbs.

### 10. CORS is fully wildcard (P2)
**Source:** GPT-5.3 Codex (Feb 2026)
**Location:** `cloud-service/src/server.ts`
**Issue:** `Access-Control-Allow-Origin: *` on all responses. Bearer auth still protects routes, but origin restrictions would tighten exposure.
**Fix:** Restrict CORS to known origins (web companion, desktop).

### 11. `sessions:save-sync` cloud forwarder ignores non-2xx (P2)
**Source:** GPT-5.3 Codex (Feb 2026)
**Location:** `cloudRouter.registerSaveSyncForwarder`
**Issue:** Only network failures are caught; HTTP 4xx/5xx responses are silently ignored.
**Fix:** Log and optionally retry on non-OK responses.

### 12. Session migration is sequential (P2)
**Source:** Kimi K2.5 (Feb 2026)
**Location:** `cloudMigrationService.ts`
**Issue:** Each session is uploaded via individual `PUT /api/sessions/:id`. For 500+ sessions, this is slow.
**Fix:** Add `/api/sessions/batch` endpoint for bulk import.

### 13. Pairing rejects degraded-but-usable clouds (P2)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `cloud-client/src/auth/createAuthStore.ts`
**Issue:** Auth store only accepts `health.status === 'ok'`. Detailed checks exist server-side but clients do not use them.
**Impact:** Warning/degraded states block pairing even when most features still work.
**Fix:** Accept degraded health with a warning rather than rejecting outright.


---


## Security

### 14. Bearer token has no rotation or expiry (P1)
**Source:** Kimi K2.5 (Feb 2026)
**Location:** `cloud-service/src/auth.ts`
**Issue:** Single static Bearer token with no rotation, expiry, or revocation. Token compromise = full access until manually changed.
**Fix:** Short-term: token rotation endpoint. Medium-term: short-lived JWTs with refresh token rotation.

### 15. WebSocket auth token in URL query params (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `cloud-client/src/cloudClient.ts` (L391, L448), `cloud-service/src/server.ts` (L235, L245-247)
**Issue:** `cloud-client` opens `/api/events?token=...` and `/api/agent/turn?token=...`. Server rewrites query token into `Authorization`. Token can leak via proxy/access logs, browser devtools, or copied URLs.
**Impact:** Bearer token exposure in non-header locations.
**Fix:** Use first-message auth protocol or upgrade header auth. The query param approach was chosen for RN WebSocket compatibility (no custom headers), but can be improved.

### 16. Web companion stores bearer token in plaintext localStorage (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `web-companion/src/storage/webTokenStorage.ts`
**Issue:** Web token storage uses `localStorage`. Mobile uses `expo-secure-store`. Browser XSS or profile compromise yields full cloud access.
**Impact:** Weaker security posture on web vs mobile.
**Fix:** Use `sessionStorage` (lost on tab close), or encrypt token client-side with a derived key, or consider HttpOnly cookie auth for web.

### 17. Cloud auth relay persists third-party OAuth tokens in plaintext (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `cloud-service/src/routes/auth.ts` (L49-57)
**Issue:** `/api/auth/relay` writes provider OAuth/config JSON files directly under `/data` with mode `0600`, but still plaintext on the volume.
**Impact:** Volume compromise exposes all connected third-party credentials (GitHub, Google, etc.).
**Fix:** Encrypt at rest using a key derived from the bearer token, or use Fly's volume encryption as documented defense.

### 18. Bridge token stored in plaintext settings (P1)
**Source:** GPT-5.3 Codex (Feb 2026)
**Location:** `cloudInstance.cloudToken` in `AppSettings`
**Issue:** Unlike OAuth tokens (which use `safeStorage`), the cloud bridge token sits in regular settings storage on desktop.
**Fix:** Move bridge token to `safeStorage`-backed storage.

### 19. `SecureStorage` interface is defined but not wired (P2)
**Source:** GPT-5.3 Codex, GLM-5 (Feb 2026)
**Location:** `src/core/secureTokenStore.ts`
**Issue:** Good abstraction exists but is not connected to actual token storage consumers in cloud mode.
**Fix:** Wire `SecureStorage` in cloud bootstrap, even if the cloud impl is a passthrough (with appropriate threat model documentation).


---


## Multi-Device & Sync

### 20. Desktop turns execute locally, not on shared cloud runtime (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `src/shared/cloudChannelPolicies.ts` (L51-56), `src/main/services/cloud/cloudRouter.ts`
**Issue:** `agent:turn` is removed from cloud routing. Desktop turns now execute locally and sync to cloud later via save-sync/outbox. Other devices get eventual continuity, not live shared execution.
**Impact:** Mobile/web see completed turns, not live streaming from desktop-initiated turns.
**Fix:** Architectural decision (not a bug). True multi-device live streaming would require re-enabling cloud-routed turns or a pub/sub event relay.

### 21. Continuity is opt-in and defaults local-only (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `src/main/services/cloud/cloudContinuityMetadata.ts` (L19-20)
**Issue:** Sessions are `local_only` unless explicitly promoted to `cloud_active`. Continuity state map only pushes every 60 seconds.
**Impact:** Many desktop sessions never appear on mobile/web. Users must manually promote sessions. Delay in state propagation.
**Fix:** Consider auto-promoting sessions that receive mobile/web interactions, or making `cloud_active` the default.

### 22. No per-device targeting or presence model (P2)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `cloud-service/src/cloudEventBroadcaster.ts` (L29-33), `cloud-service/src/pushStore.ts`
**Issue:** `cloudEventBroadcaster` tracks anonymous WS clients in a `Set`. Push store only remembers `{deviceToken, platform, registeredAt}`. No device identification, presence, or selective routing.
**Impact:** Cannot target notifications to specific devices. Cannot show "active on device X" indicators. Cannot implement device-specific conflict resolution.
**Fix:** Add device ID to WS connections and push registrations.

### 23. No offline cache beyond auth credentials (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `cloud-client/src/stores/sessionStore.ts`, `cloud-client/src/stores/inboxStore.ts`
**Issue:** Mobile/web persist credentials only. Session/inbox/approval stores are in-memory Zustand state. App restart or offline = no local read cache, no offline continuity.
**Impact:** Users cannot read conversations or inbox items when offline. Every app launch requires full re-fetch.
**Fix:** Add persistent cache layer (AsyncStorage/IndexedDB) behind Zustand stores with stale-while-revalidate pattern.

### 24. Delta sync is partial (P2)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `cloud-client/src/cloudClient.ts`
**Issue:** Session event push/pull now uses symmetric deltas, but session lists and inbox loads still have broader pagination/cache gaps.
**Impact:** The 2026-05 body-cap pressure for full-session conversation pushes is closed; cold-start list/inbox scale can still hurt latency and memory.
**Fix:** Keep session event delta sync (`docs/plans/260509_session_event_delta_sync.md`) in place; separately add cursor pagination and persistent companion caches for list/inbox loads.
**Monitoring:** Alert on renewed full-session PUT dominance, 413/BODY_TOO_LARGE retries, p95 delta payload growth, `needs-reconcile` spikes, and `_deletedMessages` / `_destructiveOpsLedger` growth. If any of those move, the smoke alarm is not being theatrical.

### 25. Workspace sync is throttled and incomplete (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `src/main/services/cloud/cloudWorkspaceSync.ts` (L20, L31, L61, L76)
**Issue:** 5-minute throttle between syncs. 7MB per-file upload cap (base64 expansion). Text-only/new-file pull guards. Safety caps on pull volume.
**Impact:** Mobile/web cloud workspace can lag or miss large/binary changes. Memory facts may be stale.
**Fix:** Reduce throttle for small/critical files (memory facts). Consider streaming uploads for large files.

### 26. Lean session data loses fidelity (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `cloud-service/src/routes/sessions.ts` (L12-28, L37-88)
**Issue:** Cloud only returns tool events in lean mode. Tool `detail` is truncated to 500 chars. Image content is dropped above 10MB/turn.
**Impact:** Mobile/web cannot fully reproduce desktop turn timelines and rich artifacts.
**Fix:** Snapshots from live WS mitigate this for active sessions (implemented in `useAgentTurn`). For historical sessions, consider on-demand full detail fetch.

### 27. Client-side search runs on partial local datasets (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `mobile/app/(tabs)/conversations.tsx`, `web-companion/src/screens/ConversationsScreen.tsx`
**Issue:** Both mobile and web search/filter only the already-fetched session list. Both fetch `activeOnly`, missing non-active history.
**Impact:** "Search" is incomplete and misses archived/inactive conversations.
**Fix:** Add server-side session search endpoint, or fetch full session list for search.


---


## Mobile App Limitations

### 28. Mobile surface is narrow vs desktop (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `mobile/app/(tabs)/_layout.tsx` (4 tabs: Home, Actions, Conversations, Help)
**Issue:** No mobile settings, workspace browser, library viewer, memory/spaces explorer, automation manager, or admin surfaces. These all require desktop.
**Impact:** Users must switch to desktop for any configuration or workspace management.
**Fix:** Incremental -- add read-only versions of the most-requested surfaces (workspace browser, settings viewer).

### 29. Conversations screen only loads active sessions (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `mobile/app/(tabs)/conversations.tsx` (L241-281), `cloud-service/src/routes/sessions.ts` (L221-239)
**Issue:** Mobile conversations screen fetches `fetchSessions({ activeOnly: true })`. Server `activeOnly` means `cloud_active`; the core active filter is `isSessionActive` (`doneAt == null`, renamed from `pinnedAt`). Users cannot browse or search full conversation archive on mobile.
**Impact:** Historical conversations are invisible on mobile.
**Fix:** Add an "All conversations" mode with server-side pagination.

### 30. No share-link management on mobile (P2)
**Source:** GPT-5.5 (Mar 2026)
**Issue:** Mobile uses native `Share.share()` on message text. Web has `createShareLink()`/copy-link flow. Mobile cannot create or revoke public conversation share links.
**Fix:** Port web's share-link UI to mobile.

### 31. Cloud voice rejects local-only providers (P2)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `cloud-service/src/routes/voice.ts` (L125-129)
**Issue:** Cloud TTS rejects `local-parakeet` and other local-only models. Users configured for local-only voice on desktop lose spoken replies on mobile/cloud.
**Fix:** Auto-fallback to cloud-compatible provider when local model is configured.


---


## Web Companion Limitations

### 32. No QR pairing on web (P2)
**Source:** GPT-5.5 (Mar 2026)
**Issue:** Mobile supports QR scan via `expo-camera`. Web auth is manual entry or fragment token only.
**Fix:** Add URL fragment deep-link from desktop or clickable link pairing.

### 33. No TTS playback on web (P2)
**Source:** GPT-5.5 (Mar 2026)
**Issue:** Mobile wires `useMobileAudioPlayback` for TTS. Web has voice recording only, no TTS/playback path.
**Fix:** Implement Web Audio API playback using the same cloud TTS endpoint.

### 34. No diagnostics capture or export on web (P2)
**Source:** GPT-5.5 (Mar 2026)
**Issue:** Mobile Help supports `includeDiagnostics` + "Share diagnostics". Web Help only submits plain text feedback.
**Fix:** Add browser diagnostic collection (console errors, connection state, performance timeline).

### 35. No web/browser push notifications (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `cloud-service/src/routes/push.ts`
**Issue:** Push registration exists only for Expo/mobile tokens. No web push/service-worker implementation.
**Impact:** Web companion cannot receive background approvals/completions when the tab is not active.
**Fix:** Add Web Push API support with service worker registration.


---


## Push Notification Limitations

### 36. Push suppressed by any connected WS client (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `cloud-service/src/cloudEventBroadcaster.ts` (L133-160)
**Issue:** Approval pushes only fire when `this.clients.size === 0`. Having ANY connected WS client (web tab, another device) suppresses mobile push notifications.
**Impact:** Leaving a web tab open prevents mobile from getting push alerts even when the user is away from the web tab.
**Fix:** Send push notifications based on per-device activity/presence rather than global client count.

### 37. Narrow notification scope (P2)
**Source:** GPT-5.5 (Mar 2026)
**Issue:** Current push sends only tool/memory approvals, `AskUserQuestion`, turn completion, and turn error. No pushes for inbox items, workspace conflicts, or sync issues.
**Fix:** Expand push notification categories incrementally.


---


## Version Negotiation & Deployment

### 38. No version negotiation between desktop and cloud (P1)
**Source:** Kimi K2.5 (Feb 2026)
**Issue:** If the desktop app updates and changes an IPC contract, the cloud service may misinterpret calls. No handshake or compatibility check.
**Fix:** Add version exchange on cloud connect.
**Residual status (2026-04-19):** Still open. Phase 4 continuity work improved retry/reconnect observability, but explicit desktop↔cloud compatibility negotiation has not landed yet.

### 39. No client/server contract negotiation on mobile/web (P1)
**Source:** GPT-5.5 (Mar 2026)
**Location:** `cloud-service/src/server.ts` (L55-58), `cloud-client/src/cloudClient.ts`
**Issue:** Server emits `X-Rebel-Cloud-Version` header, but `cloud-client` discards response headers. Pairing only checks basic health/settings. Mobile/web can pair to incompatible cloud builds without warning.
**Fix:** Check `X-Rebel-Cloud-Version` on pair and surface mismatch warnings.
**Residual status (2026-04-19):** Still open. Phase 4 added stronger runtime breadcrumbs/logs, but mobile/web still lack explicit build-contract negotiation during pairing.

### 40. Web and API deploy together (P2)
**Source:** GPT-5.5 (Mar 2026)
**Issue:** Same cloud service binary serves web companion SPA + API + WS. Frontend rollout and backend rollout are coupled.
**Fix:** Serve web companion from CDN or separate deployment.

### 41. Settings change triggers unnecessary cloud reconnection (P2)
**Source:** GPT-5.3 Codex (Feb 2026)
**Location:** `src/main/index.ts` (`settingsStore.onDidAnyChange`)
**Issue:** Every settings mutation (not just `cloudInstance` changes) calls `cloudRouter.updateConnection(...)`, causing unnecessary disconnect/reconnect cycles.
**Fix:** Filter to only react when `cloudInstance` fields actually change.
**Status (2026-06-18): still open** — `src/main/index.ts` still calls `cloudRouter.updateConnection(...)` on settings changes (no `cloudInstance`-only filter yet). A **related** race *was* fixed (2026-06-18): `updateConnection()` setup is now serialized via `connectionEpoch` guards in `src/main/services/cloud/cloudRouter.ts` (`updateConnection`, `disconnect`), and in-flight pull cascades capture the epoch and discard stale-account writes on disconnect — so the redundant reconnects are no longer *unsafe*, but the over-triggering itself remains to be filtered out. Implementation reference: [CLOUD_CONNECTION_LIFECYCLE.md](CLOUD_CONNECTION_LIFECYCLE.md).


---


## Protocol & API

### 42. Event channel reconnection race condition (P2)
**Source:** Gemini 3.1 Pro (Feb 2026)
**Location:** `cloudEventChannel.ts`
**Issue:** Events arriving during the HTTP catch-up fetch on reconnect might be duplicated or lost. No deduplication or sequence numbering.
**Fix:** Add event sequence IDs or timestamps for deduplication.
**Resolved (2026-04-19):** `cloud-client/src/stores/sessionStore.ts` now treats seq as the ordering/dedupe source of truth, `cloud-client/src/components/EventBridge.tsx` catches up on reconnect, and reconnect telemetry now flags large seq gaps (`server-restart-detected`) instead of dropping the transition silently.

### 43. Error propagation inconsistency (P3)
**Source:** Kimi K2.5 (Feb 2026)
**Issue:** Some cloud error paths return `{ error: { code, message } }`, others throw. The `CloudServiceError` duck-typing is fragile.
**Fix:** Standardize error shape across all cloud communication paths.

### 44. No distributed tracing (P3)
**Source:** Kimi K2.5 (Feb 2026)
**Issue:** A single agent turn spans WebSocket, handler, Claude API, and MCP tools, but there's no trace ID to follow the flow end-to-end.
**Fix:** Pass a request/trace ID through the turn lifecycle.

### 45. Adding a cloud-routable channel requires editing 3 files (P2)
**Source:** Kimi K2.5 (Feb 2026)
**Issue:** New channel needs: policy table entry, `CHANNEL_TO_ENDPOINT` mapping, and a server route. No validation that all 3 stay in sync.
**Fix:** Add a policy-to-handler parity test.


---


## Testing Gaps

### Cloud service
1. **Cloud bootstrap contract test** -- Verify each registered handler receives correct deps (prevents #1)
2. **WS close-before-result cleanup** -- Assert listener removal on socket close (prevents #2)
3. **Push notification service tests** -- No dedicated tests for `pushNotificationService.ts` dedup/prune behavior
4. **Policy-to-handler parity** -- Every routable channel must have a cloud handler (prevents #45)

### Mobile
5. **No push notification tests** -- Push receiving, deep-linking, and token registration lack test coverage
6. **No reconnection/AppState tests** -- NetInfo/AppState reconnect flows are untested
7. ~~**No diagnostics export tests**~~ -- **Resolved (2026-04-19):** added mobile diagnostics bundle tests (`mobile/src/__tests__/diagnosticBundle.test.ts`), desktop ZIP continuity bundle tests (`src/main/services/__tests__/logExportService.continuity.test.ts`), and cloud self-diagnostics route coverage (`cloud-service/src/__tests__/diagnosticsRoute.test.ts`)

### Web companion
8. **Thin test coverage** -- Only `e2e.integration.test.ts` exists. No focused tests for help, share, voice, connectivity, or event bridge
9. **Save-sync forwarder response handling** -- Non-OK HTTP responses should be logged/retried (prevents #11)


---


## Resolved Items

| # | Issue | Resolution |
|---|-------|-----------|
| -- | Protocol drift between cloud-bridge and cloud-service | `cloud-bridge/` removed. Only `cloud-service/` remains. |
| 7 | No diagnostics export tests | Resolved via new mobile, desktop ZIP continuity, and cloud self-diagnostics route tests (see `mobile/src/__tests__/diagnosticBundle.test.ts`, `src/main/services/__tests__/logExportService.continuity.test.ts`, `cloud-service/src/__tests__/diagnosticsRoute.test.ts`). |
| -- | fly.toml uses `performance-4x` (16GB RAM) | Now uses `performance-2x` (4GB). User instances use `shared-cpu-4x`. |
| -- | Cloud-bridge may be removable | Removed. |
| -- | No circuit breaker for cloud calls | Implemented as escalating failure cooldown in `cloudFailureCooldown.ts` (3→30s, 6→2m, 10→5m, 15→15m). |
| -- | CloudTab status type mismatch | Addressed via provider state model and discovery flow. |
| -- | Multi-window concurrency | Partially addressed via `getBroadcastService().sendToAllWindows()`. |
| 42 | Event channel reconnection race condition | Resolved via seq-based catch-up ordering/deduping in `cloud-client/src/stores/sessionStore.ts` plus reconnect handling/telemetry in `cloud-client/src/components/EventBridge.tsx`. |
