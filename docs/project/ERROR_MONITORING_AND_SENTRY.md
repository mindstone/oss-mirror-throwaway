---
description: "How Mindstone Rebel captures and reports errors to Sentry — capture pipeline, classification taxonomy, level/sink conventions, known-condition registry, and fingerprint disambiguation patterns"
last_updated: "2026-06-20"
---

# Error Monitoring (Sentry)

How Mindstone Rebel captures and reports errors to Sentry for observability and debugging.

### See Also

- [LOGGING.md](./LOGGING.md) — Structured logging architecture; recent logs are attached to Sentry events
- [DEBUGGING.md](./DEBUGGING.md) — Practical debugging workflows using both logs and Sentry
- [SENTRY_TRIAGE.md](./SENTRY_TRIAGE.md) — Operational process for triaging Sentry issues
- [SENTRY_AUTOPILOT.md](./SENTRY_AUTOPILOT.md) — Sentry Autopilot operating reference: dispatcher loop, feature flags, rollback
- [TRIAGE_AND_FIX_ASSIGNED_TICKETS_LINEAR_SENTRY.md](./TRIAGE_AND_FIX_ASSIGNED_TICKETS_LINEAR_SENTRY.md) — End-to-end runbook: pull, fix, and close a batch of assigned Linear+Sentry tickets
- [ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md](./ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md) — RudderStack behavioral analytics (separate from error telemetry)
- `src/main/sentry.ts` — Main process Sentry initialization and capture functions
- `src/renderer/src/sentry.ts` — Renderer process Sentry integration
- `src/shared/telemetry/sentryConfig.ts` — Shared configuration options, enablement, and sampling
- [DIAGNOSTICS.md § Continuity breadcrumbs](./DIAGNOSTICS.md#continuity-breadcrumbs) — Mobile/cloud-client continuity observability (session merge, outbox, catch-up, state transitions, conflict detection) plus the `setLogErrorReporter()` bridge that surfaces cloud-client `warn`/`error` lines as Sentry breadcrumbs.
- `cloud-client/src/observability/continuityEvents.ts` — `ContinuityTransitionEvent` contract and SAFE_KEYS allowlist.
- `mobile/src/utils/continuityBreadcrumbs.ts` — Mobile dispatcher for continuity breadcrumbs and throttled escalations.


### Principles

- **Startup failures are captured**: Early app startup errors are reported to Sentry to diagnose issues users may not report
- **Tags for filtering**: All captures include structured tags (`area`, `component`, etc.) for Sentry dashboard filtering
- **Logs attached**: Recent logs (in-memory ring buffer) are attached to **main-process** exception events for debugging context. The buffer holds a **~5-minute / ≤1000-entry tail**, and the emitted `recent-logs.ndjson` attachment is hard-capped at `MAX_LOG_ATTACHMENT_SIZE` (100KB, tail) so it can't trip Sentry's `too_large` ingest drop. (This was a 10-second / 200-entry window until 2026-06-21 — far too little context, which forced most serious incidents to be diagnosed from the user's full `.zip` instead of the Sentry event; see `docs/plans/260621_monitoring-capture-surface/`.) The separate **60-minute** window is a disk-read path used only for the unclean-shutdown report (`crashRecoveryService.ts`), not ordinary captures. The **renderer** process attaches no log buffer yet (known gap — staged).
- **Health context**: System health status is included as Sentry context for correlation
- **Privacy by default**: Sentry hooks and attachment builders apply layered redaction wherever the client controls the payload (all four surfaces now share `redactSentryEvent` for error events). One known exception: sensitive-keyed breadcrumb `data` can still reach the wire via an unresolved hook bypass — Sentry's server-side scrubbing is the at-rest backstop there; see the breadcrumb wire-channel caveat below (§ outgoing-event sweep) and the routed follow-up.
- **Session Replay privacy**: Replay integration uses `maskAllText`, `maskAllInputs`, and `blockAllMedia` to prevent capturing sensitive UI content


### Architecture

#### Main Process (`src/main/sentry.ts`)

| Export | Purpose |
|--------|---------|
| `initMainSentry()` | Initialize Sentry early in startup (called before `app.on('ready')`) |
| `captureMainException(error, context?)` | Capture exception with recent logs attached |
| `captureMainMessage(message, context?)` | Capture informational/warning messages |
| `captureMainExceptionWithHealth(error, context?)` | Capture exception after refreshing health context |
| `setHealthContext(summary)` | Update Sentry context with system health status |
| `setSentryUser(user)` | Set user identity (anonymousId, email) |
| `recordMainBreadcrumb(breadcrumb)` | Add navigation/action breadcrumb |

#### Renderer Process (`src/renderer/src/sentry.ts`)

- `initRendererSentry()` — Initialize Sentry in renderer (called before analytics init)
- React error boundaries capture uncaught UI errors
- Renderer can also capture via main process IPC
- `beforeBreadcrumb` and `beforeSend` hooks redact sensitive data (API keys, emails, user paths)
- Browser tracing and Session Replay integrations with privacy-preserving defaults
- **Renderer log attachment (added 2026-06-21, Stage 4).** Renderer captures previously attached NO logs — only redacted breadcrumb *messages* (renderer log-breadcrumb `data` is dropped at `beforeBreadcrumb` because the stricter `@core` deny-by-default log allowlist can't cross the renderer↔core boundary), so a renderer error reached Sentry almost context-free. `captureRendererException` / `captureRendererMessage` now attach a `recent-renderer-logs.ndjson` from a renderer-local ring buffer (`src/renderer/src/rendererLogBuffer.ts`, ~5-min / ≤1000-entry tail, fed by `emitLog` in App.tsx + the pre-AppContext perf emitter in main.tsx), redacted with the SAME `@shared` redactors (`redactSensitiveString` + `redactObjectDeep`) the MAIN attachment path uses (`formatLogsForAttachment`). This is parity with main's attachment — the main log buffer is NOT pre-filtered on ingest (`logger.ts` stores raw `data`; redaction happens only at attachment time), so the stricter breadcrumb allowlist is a separate, distinct path. Attached via `withScope` + `scope.addAttachment` (same mechanism as main). 100KB tail cap (`MAX_RENDERER_LOG_ATTACHMENT_SIZE`) so it can't trip `too_large`. "More of the same, redacted" — no new data types.
- **Mount-failure capture (added 2026-06-21, C2/Stage 3).** `ReactDOM.createRoot().render()` in `main.tsx` is wrapped in try/catch → `captureRendererException` (then re-throws). The `SentryErrorBoundary` only catches render-phase errors AFTER mount; a synchronous throw during the mount call (missing `#root`, a provider constructor throw) previously left the renderer blank with nothing captured — the "app launched but the UI is dead" class.

#### Positive interactivity signal — `App Reached Interactive` (added 2026-06-21, C2/Stage 3)

`Application Opened` (main process, `did-finish-load`) fires when the page *loads*, which over-counts blank/stuck renderers as healthy. `tracking.app.reachedInteractive(...)` (analytics, `src/renderer/src/tracking.ts`) fires once per renderer session the first time the UI is genuinely interactive (settings loaded, not blocked by login/onboarding/recovery — computed in `App.tsx`). A blank/stuck cohort is then detectable by this event's **absence** relative to `Application Opened` (pairs with the active-detection / alerting workstreams' cohort absence-alert). Low-cardinality props only (`msSinceBoot`, `safeMode`).

#### User Identity

- `id` field: Set to `anonymousId` (stable UUID from main process)
- `email` field: Set to user's email when available
- Both set via `setSentryUser()` in main and `setUser()` in renderer


#### Mobile (React Native / Expo)

Mobile uses `@sentry/react-native`, initialised at `mobile/app/_layout.tsx` (module scope) via `initSentry()` in `mobile/src/utils/sentry.ts`. The mobile adapter (`mobileErrorReporter`) is structurally compatible with `@core/errorReporter`, and its `beforeSend`/`beforeBreadcrumb` route through the **same shared `redactSentryEvent` chokepoint** (`src/shared/utils/sentryRedaction.ts`) as the other surfaces. Hardened 2026-06-12 — see `docs/plans/260612_mobile-analytics-error-monitoring/PLAN.md`.

- **Identified by email (matches desktop).** `setSentryUser({ email })` post-pair from `cloudClient.getSettings().userEmail`, cleared on both unpair paths. Email is the SDK-managed PII channel; existing shared redaction is unchanged. Graceful degradation to no-user when email is absent.
- **Health context:** a slim startup/health context (`setSentryHealthContext` — app version, runtime version, paired/unpaired, online state) mirrors desktop's `setHealthContext` where it makes sense on mobile.
- **Crash & rejection capture is verify-not-rewire.** `@sentry/react-native` v7 captures native crashes AND unhandled JS promise rejections by default under Hermes (RN 0.81 + new arch); the app does not disable them and deliberately does NOT add duplicate global/rejection handlers (the `ErrorUtils.setGlobalHandler` in `_layout.tsx` re-routes to the same client, no second report). The dev-build verification procedure (deliberate rejection / thrown error / `Sentry.nativeCrash()`) is documented as a QA note in the header of `mobile/src/utils/sentry.ts`.
- **No mobile Sentry double-count.** Mobile captures client-side JS/native crashes; the cloud instance captures server-side errors for the same session — disjoint by where the error occurs.
- **Production symbol upload (the "no symbol upload" fix).** Three load-bearing pieces, not one: (1) the **Sentry Metro plugin** — `mobile/metro.config.js` uses `getSentryExpoConfig` (preserving the monorepo resolver/`watchFolders`) so JS bundles carry Debug IDs; (2) drop `SENTRY_DISABLE_AUTO_UPLOAD` on the **production** EAS profile only (kept on `e2e`) in `mobile/eas.json`; (3) `SENTRY_AUTH_TOKEN` injected as a **secret-visibility env var in the `production` EAS environment** (not a legacy project-wide secret — keeps it out of preview/dev/e2e). **Android** native symbolication additionally needs the Sentry **Android Gradle Plugin**, enabled via `"experimental_android": { "enableAndroidGradlePlugin": true }` on the `@sentry/react-native/expo` plugin block in `mobile/app.json` (without it, only Android *JS* sourcemaps upload). Real-build upload verification is an ops/release-gate step. **Key delivery is CI-automated:** the mobile build workflows sync `SENTRY_AUTH_TOKEN` (and the runtime DSN) from GitHub secrets into the production EAS environment before each `eas build`, so it no longer requires a manual `eas env:create`. The full pass-through flow, rotation, and verification are in [MOBILE_TELEMETRY_KEYS.md](./MOBILE_TELEMETRY_KEYS.md). Standing prerequisite: the GitHub secret must exist and be in scope, or crashes ship unsymbolicated.
- **iOS privacy manifest.** Sentry's required-reason APIs and collected-data types are declared via `expo.ios.privacyManifests` in `mobile/app.json` (UserDefaults `CA92.1`, SystemBootTime `35F9.1`, FileTimestamp `C617.1`; Crash/Performance/Other Diagnostic Data). Because mobile identifies by email, Usage Data/Diagnostics are declared **Linked to identity** but still **`NSPrivacyTracking: false`** with empty tracking-domains — so no ATT prompt. Analytics (RudderStack) adds further rows; the analytics architecture is in [ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md § Mobile](./ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md#mobile-react-native--expo). The generated `PrivacyInfo.xcprivacy` (post-prebuild) is the integrity source of truth, verified at the release gate, not from `app.json` alone.

Key files: `mobile/src/utils/sentry.ts`, `mobile/app.json`, `mobile/eas.json`, `mobile/metro.config.js`.

### Startup Error Monitoring

Startup failures are especially important to capture—users often don't report "the app didn't start properly" issues. The following startup errors are automatically captured:

#### Super-MCP Startup Failures

**Location**: `src/main/services/systemHealthService.ts` → `startSuperMcpWithRetries()`

When Super-MCP exhausts all retry attempts during startup contexts:

```typescript
captureMainException(lastErrorObj, {
  tags: { area: 'startup', component: 'super-mcp', startup_context: context },
  extra: { attempts: attemptCount, lastError }
});
```

**Contexts captured** (startup-related only):
- `startup` — Initial app startup
- `preflight` — Onboarding preflight checks
- `app-ready` — Post-window-creation startup

**Not captured**: Manual restarts (`ipc-restart`, `klavis-save`, etc.) are user-initiated and excluded to avoid noise.

#### Super-MCP Unexpected Errors

**Location**: `src/main/index.ts` → `app.on('ready')` handler

If the Super-MCP startup promise chain throws unexpectedly:

```typescript
captureMainException(err, {
  tags: { area: 'startup', component: 'super-mcp', startup_context: 'app-ready' }
});
```

#### Renderer Load & Process-Gone Failures (the blank/white-screen class, added 2026-06-21)

**Location**: `src/main/index.ts` — the `did-fail-load`, `render-process-gone`, and `child-process-gone` handlers.

These are the literal "app launched but the UI is dead / blank screen" events — the "Rebel won't work at all" class users rarely report well. They were logged to pino only, so a renderer that failed to load (or a renderer/GPU process that crashed) was **invisible to fleet monitoring** and made a broken cohort look healthy in Sentry. Each handler now also captures to Sentry:

- `did-fail-load` (main frame) → `captureMainException`, tags `area:'renderer', component:'load'`, extras `errorCode`/`errorDescription`/`validatedURL`. Reuses the existing `hasShownLoadError` latch + ERR_ABORTED / non-main-frame guards so benign aborts and duplicates don't fire.
- `render-process-gone` → tags `area:'renderer', component:'crash'`, extras `reason`/`exitCode`/`url`. Skips the benign `clean-exit` teardown (`shouldCaptureProcessGone`).
- `child-process-gone` (GPU/utility) → tags `area:'process', component:'crash'`, extras `type`/`reason`/`exitCode`. Skips `clean-exit` AND throttles per `(type+reason)` for 5 min (`shouldCaptureChildProcessGoneThrottled`) so a crash-looping GPU process can't storm Sentry / page the team.

All three use the **synchronous** `captureMainException` (not the health-refreshing async path) so the event egresses immediately even if a health check is slow or blocked — important because these crashes coincide with the self-concealing-failure conditions where awaiting health could hang. Decision logic is unit-tested in `src/main/utils/processGoneCapture.ts`.

#### Unclean Shutdown Reporting

On startup, `reportUncleanShutdownIfNeeded()` checks if the previous exit was clean. If not:
- Exports recent logs (~60 min window) and attaches them to Sentry
- Sends a warning: "Unclean shutdown detected from previous session"
- Uses cooldown store to prevent crash-loop floods (1 hour)

Key files: `src/main/services/crashRecoveryService.ts`, `src/main/services/gracefulShutdown.ts`

#### Auth Fetch Timeouts

**Location**: `private/mindstone/src/services/authService.ts` → `fetchUserInfo()`

Auth user info fetch has a 5-second timeout during startup to prevent indefinite hangs. If timeout occurs:

```typescript
captureMainMessage('Auth fetch timed out during startup', {
  level: 'warning',
  tags: { area: 'startup', component: 'auth' },
  extra: { timeoutMs }
});
```

This ensures the app opens quickly and falls back to cached user data rather than hanging.

#### Cloud Self-Update & Rollback Visibility (added 2026-06-07)

**Locations**: `cloud-service/src/selfUpdateScheduler.ts`, `cloud-service/src/services/cloudUpdateStatus.ts`

The cloud auto-update + image-rollback layer previously logged only via the scoped logger (Sentry *breadcrumbs*, never *captures*) and the pre-bootstrap watchdog runs before Sentry init — so update failures and auto-rollbacks were invisible in Sentry. Two explicit captures close the gap:

- **`cloud.self_update.failed`** — emitted by the cloud-side self-updater at genuine-failure points only (NOT on rate-limit / agent-turn deferral / quarantine skip / up-to-date). Grouped by `cause` (`fingerprint: ['cloud.self_update.failed', cause]`). Levelled by cause: `warning` for real failures (`tag-resolve-failed`, `fly-update-failed`, `vm-signal-write-failed`, `cycle-exception`); `info` for known-degraded config (`fly-token-missing`, `fly-env-missing`) that self-heals once the desktop bootstraps the Fly token.
- **`cloud.image_rollback.recovered`** — emitted on the next healthy boot after the watchdog rolled the machine back to its last-known-good image (deduped across boots via a `/data/.rollback-reported.json` marker). `level: 'error'` (re-leveled from warning 2026-06-11 so it stays alertable under a level-filtered alert rule — designated leave-alertable); high-signal — a released image crash-looped in production. The bad tag is in `extra.rolledBackFromTag`.

The fully-crash-looping case (rollback failed / cap exceeded) cannot reach Sentry init and is detected desktop-side via Fly machine-state polling. The basic `/api/health` response also carries a `cloudUpdate` summary (`status: 'ok' | 'recently-rolled-back'`, `quarantinedTags`, `lastKnownGoodImageTag`) for the desktop reconciler. See [SENTRY_TRIAGE § Cloud update / rollback health](./SENTRY_TRIAGE.md#cloud-update--rollback-health-added-2026-06-07).

#### Cloud offline transport (added 2026-06-21, C3/Stage 5)

The cloud service initialised `@sentry/node` with **no offline transport**, so a cloud instance that couldn't reach Sentry — exactly the moment a connectivity bug is happening — dropped its events **permanently**. Desktop main (`@sentry/electron`) and mobile already persist offline; cloud was the lossy asymmetry. `cloud-service/src/bootstrap.ts` now wraps the Node transport with `@sentry/core` `makeOfflineTransport`, backed by a disk-queue on the Fly `/data` volume (`cloud-service/src/sentryOfflineStore.ts`). Envelopes survive a transport failure and replay when connectivity returns (`flushAtStartup: true` replays anything queued from a prior crash/outage). The store is **bounded** (≤200 envelopes / ≤20MB, oldest-evicted) so a long outage can't fill the volume, and every fs op is best-effort (a store failure degrades to "drop this one envelope", never crashes telemetry).


### Diagnostic Enrichments for Bug Reports

Bug report submissions include additional Sentry contexts and extras to enable self-diagnosable issues (motivated by REBEL-132). See [planning doc](../plans/260327_bug_report_diagnostic_enrichment_phase2.md) for full privacy analysis and design decisions.

> **Delivery model (260622 — robust by construction).** The bug-report submit path no longer fire-and-forgets after enrichment. The raw report is captured-first under hard enrichment deadlines, **durably persisted to disk before the dialog confirms** (`src/main/services/bugReportOutbox.ts` — atomic write + `fsync`, replay-until-confirmed-2xx, dead-letter that emits its own Sentry event), and each submission gets a **per-report fingerprint** (`['user-bug-report', title, report_id]`) so it is its own issue and the Sentry→Linear automation fires per report. `source=user-bug-report` events are also **exempt from `beforeSend` message-content drops** (a user pasting a backend error must not be filtered). Intent that must not be reversed: [`docs/plans/260622_feedback-bug-robustness/PLAN.md` → Intent & Design Rationale](../plans/260622_feedback-bug-robustness/PLAN.md).

#### Feature Gates Context (`featureGates`)

A dedicated Sentry context set via `setFeatureGatesContext()` in `src/main/sentry.ts`, updated from `updateSentryHealthContext()`. Contains tri-state (`boolean | undefined`) values — `undefined` (never set) is diagnostically distinct from `false`:
- `meetingBotUnlocked`, `managedCloudEnabled`, `mcpServerEnabled`, `onboardingCompleted`, `indexingEnabled`

#### Extended Health Context

The `systemHealth` Sentry context now includes two additional fields set from `updateSentryHealthContext()` in `systemHealthService.ts`:
- **`safeCheckDetails`** — Privacy-safe details extracted from failing/warning health checks using a per-check allowlist (`SAFE_CHECK_DETAIL_FIELDS`). Only specific checks with known-safe fields are included (e.g., `toolIndexHealth`, `bundledServers`, `mcpSkippedServers`, `superMcpRunning`). Checks containing PII (auth, profile, apiKeys) are excluded entirely. Capped at 4KB per check.
- **`toolIndexByServer`** — Per-server tool counts keyed by safe base server names (not raw instance IDs, which can contain email slugs).

#### Bug Report Extras

Bug report events (`bugReportHandlers.ts`) attach explicit Sentry extras:
- `feature_gates` — JSON with tri-state gate values
- `mcp_registration_lifecycle`, `mcp_registration_gated`, `mcp_registration_failed` — MCP registration status (see [DIAGNOSTICS.md](./DIAGNOSTICS.md#mcp-registration-status-tracking))

**Privacy constraint**: Health check `details` use a per-check allowlist (NOT generic filtering) because checks contain `userEmail`, `userFirstName`, API key prefixes, and file paths. See `SAFE_CHECK_DETAIL_FIELDS` in `systemHealthService.ts`.


### Breadcrumb & Diagnostic Privacy

Review rule for changes on this surface: enumerate **every** outbound channel — event fields, contexts, breadcrumbs, attachments, and renderer bridges — and test each against benign-key proprietary content (innocuous-looking keys carrying user/business data), not only obviously sensitive fields.

#### Log-breadcrumb `data` allowlist

`category:'log'` Sentry breadcrumbs route their `data` payload through a **deny-by-default allowlist** (`redactLogBreadcrumbData` in `src/core/utils/logFieldFilter.ts`) before send, so only explicitly-permitted fields survive. Renderer `renderer.log` breadcrumb `data` is dropped **entirely** (the renderer surface has no allowlisted fields worth keeping). A `server_name` scrub backstop is retained as defense-in-depth on top of the allowlist. A gated live adversarial-PII test guards this surface. (commit `4c77a28ac`; files `src/core/utils/logFieldFilter.ts`, `src/main/sentry.ts`, `src/renderer/src/sentry.ts`, `src/shared/utils/sentryRedaction.ts`)

#### CI-e2e noise filter

The CI-e2e noise filter (`isExpectedCiE2eNoise` in `src/renderer/src/sentry.ts`) matches `AgentSessionError` by exception **type**, not by the humanised message. The previous message-based match never fired, so REBEL-184/183/185 mock-noise leaked into triage. (commit `d20fd6eed`)

#### Bug-report diagnostic filter preserves structured errors

The bug-report log filter uses a key-aware `sanitizeNestedFieldValue` (`src/core/utils/logFieldFilter.ts`) that preserves canonical `Error` keys (`name`, `message`, `stack`) while dropping content-bearing custom props, instead of stringifying a nested `err` object to the useless `"[object Object]"`. (commit `947d790d4`)

#### Self-referential log-write exhaustion drop (REBEL-15G / REBEL-660 / REBEL-69M, 2026-06-19)

When the logger/transport itself can't write a log line because the disk is full (`ENOSPC`) or file descriptors are exhausted (`EMFILE`/`ENFILE`), reporting "we couldn't write a log" to Sentry is self-referential, environmental (the user's disk / FD limit), and self-amplifying. The main-process `beforeSend` now drops these events while keeping the breadcrumb: `isLoggerWriteResourceExhaustionEvent` in `src/main/sentry.ts` matches an exception whose message starts with `ENOSPC:`/`EMFILE:`/`ENFILE:` **and** has a logger/transport frame (`matchesLoggerTransportFrame` — `core/logger`, `logBuffer`, `pino`, `sonic-boom`, `thread-stream`). A data-store carve-out (`matchesDataStoreFrame` — `storeFactory`, `settingsStore`, `assetStore`, `contentStore`, `secureTokenStore`, `sourceMetadataStore`, `fileIndexService`) keeps genuine data-write exhaustion (potential data loss) surfacing even if a logger frame is also on the stack. Main-process scoped (the file-write transport is a main-process concern). This is separate from the `MAX_TRANSPORT_ERROR_REPORTS` budget on the dead-worker capture path in `src/core/logger.ts` (REBEL-5RT) — that path still reports the original transport error; the drop here is only for resource-exhaustion *writing* a log line. (commit `8c19e9f497`)

#### Transient MCP config-read failure → warn, not fail (REBEL-ZF, 2026-06-19)

A transient file-descriptor exhaustion (`EMFILE`/`ENFILE`) reading the MCP config self-heals once FD pressure clears. `checkMcpConfigValid` in `src/main/services/health/checks/mcp.ts` now classifies it as `warn`, not a hard `fail`: the `error` branch returns `warn` when `summary.error === MCP_CONFIG_FS_EXHAUSTION_MESSAGE`, and the defensive `catch` returns `warn` when `isTooManyOpenFilesError(error)` (`@core/utils/emfileRetry`). A hard `fail` is non-transient in App.tsx's health-toast aggregator, so it would drive an error-level "needs attention" toast plus a Sentry event for a blip that resolves on the next poll; genuine/persistent config errors (read+recreate or parse+recreate failure) still `fail`. (commit `0ef5f80ee6`)

### Outgoing-event UTF-16 well-formedness sweep (invalid_json class kill, 2026-06-11)

**Why:** Sentry's ingest pipeline (Relay) parses event JSON with Rust serde, which rejects unpaired-surrogate escapes (`\udXXX`) as `invalid_json` — dropping the **whole envelope, attachments included**, *after* the transport has already received HTTP 200. JavaScript tolerates such strings: any naive UTF-16 `.slice()` through an emoji can mint one, and the SDK's *own* truncation (e.g. breadcrumb truncate@2048) runs **after** app hooks like `beforeBreadcrumb` — so no producer-side fix can be complete; only the final outgoing-event chokepoint can guarantee well-formedness. This class silently discarded all in-app bug reports on Beta 2026-06-10/11 while telling users "sent".

**Mechanism** (shipped 260611; full diagnosis + design in [`docs/plans/260611_bugreport-envelope-fd-leak/`](../plans/260611_bugreport-envelope-fd-leak/PLAN.md)):

- `ensureWellFormedDeep` + surrogate-safe `truncateWellFormed` live in [`src/shared/utils/wellFormedUnicode.ts`](../../src/shared/utils/wellFormedUnicode.ts) — deep, cycle-safe, depth-capped sweep over strings **and object keys**, replacing lone surrogates with U+FFFD; replacements are observable (count + capped path summary warn, never silent).
- The sweep runs at the **end of the `redactSentryEvent` chokepoint** (`src/shared/utils/sentryRedaction.ts`) — main, cloud, renderer, and mobile `beforeSend` now all use that shared path for error events.
- `beforeSendTransaction` on main + renderer remains sweep-only (explicitly not unified in Stage 5).
- Unification does **not** close the breadcrumb wire-channel question by itself: current evidence still points to server-side scrubbing as the at-rest backstop for sensitive-key breadcrumbs across surfaces, and the renderer-envelope bypass mechanism remains a routed follow-up (`docs/plans/260611_sentry-fd-detection-followups/subagent_reports/260611_200704_stage04-arbitration.md`).
- In-repo UTF-16 splitters (`sanitizeNestedFieldValue` in `logFieldFilter.ts`, `buildBugReportTitle` and log previews in `bugReportHandlers.ts`, cloud `sentryFeedback.ts`) use `truncateWellFormed` so truncation cannot mint new lone surrogates upstream of the sweep.

**Residuals — deliberately NOT swept:** sessions, native-crash, and minidump envelopes do not pass through these hooks.

**Triage rule of thumb: HTTP 200 from the envelope endpoint ≠ delivery.** Relay accepts at the transport and can still reject during processing; such drops never appear in the issue stream — they show only in org outcome stats (`stats_v2`, e.g. `outcome:invalid reason:invalid_json`, with attachment-byte counts that can be matched against app logs). The bug-report transport log now says "accepted by Sentry transport (2xx — delivery not confirmed; processing may still reject)" for exactly this reason.

### Sentry outcome monitor (pre-ingest layer, added 2026-06-11)

The outcome monitor is the pre-ingest complement to issue-stream alerting/triage:

- Script: `scripts/sentry-outcome-monitor.mjs` (zero-dependency Node script, 3-hourly checks + digest)
- Workflow: `.github/workflows/sentry-outcome-monitor.yml` (3-hourly cron — detection latency ≤3–4h, chosen over hourly as the cost/latency sweet spot — + manual `workflow_dispatch`)
- Logic module + tests: `scripts/lib/outcomeMonitorChecks.mjs`, `scripts/__tests__/sentry-outcome-monitor-checks.test.ts`

Checks:

- **A** accepted bug-report reconciliation (`Bug Report Submitted` tracking id vs indexed `source:user-bug-report` id)
- **B** sensitive outcome-family deltas (`invalid/*`, `filtered/*`) with robust baselines + fire-edge dedup
- **C** new `(outcome, reason)` first-seen notices (24h vs prior 7d, edge-triggered)
- **D** 15:00 UTC daily digest (dead-man switch + check-A coverage-state line; 15:00 because it must be an hour the 3-hourly cron actually fires)
- **E** telemetry-delivery canary / dead-fleet detector (accepted-error volume collapse while PostHog `Application Opened` liveness holds; edge-triggered paging; inconclusive when liveness signal is unavailable or also dark). The `dark-fleet` verdict rests on an absolute accepted floor (≤5/6h) that is a >99.9% collapse at current fleet scale (accepted baseline ~thousands/6h); the floor is not fleet-relative — if accepted volume ever falls near 5/6h, revisit the floor (make it fleet-relative) to avoid false-paging a quiet-but-alive cohort.
- **F** mobile permanent-failure surge (closes FINDINGS §2 Class E "offline queue not yet a named check"). Detects a **fleet-wide spike in mobile offline-queue permanent failures** — recordings/uploads silently terminalized as `permanent` and never retried, the REBEL-6BJ / FOX-3516 class. Signal is `count_unique(user)` over the `queue_event:item-permanent-failure environment:production` Sentry events (window 6h, floor 3 distinct users; baseline read offset by the 3h run interval for fresh-vs-sustained edge dedup, paging once per surge). It triggers on **distinct users, not raw event count**, because the in-app escalation is throttled 1/hr/device/category — a raw-`count()` trigger would be dampened ~5:1 by the throttle (the exact original-incident failure mode). Fails LOUD: a missing/malformed current OR baseline read → verdict `unavailable` (never silent `quiet`) and degrades the `sentry_events` dependency feeding self-health. Pages `#rebel-monitoring`. **Scope limitation (IMPORTANT):** Check F is a *fleet-outbreak* monitor and does NOT catch a single-device repeat of the motivating REBEL-6BJ incident (1 device, 5 stuck recordings → 1 distinct user, below the floor of 3). That single-device-sustained case is covered by the P6 issue-event-frequency Sentry-rule proposal (`docs/plans/260621_monitoring-alerting-layer/OUTWARD_PROPOSAL.md`), not by Check F. Code: `evaluateCheckF` + `parsePermanentFailureAggregateRow` + constants `PERMFAIL_DISTINCT_USER_FLOOR` / `PERMFAIL_DETECTION_WINDOW_HOURS` in `scripts/lib/outcomeMonitorChecks.mjs`.
- **G** bug-report delivery reconciliation (260622): aggregate-level reconcile of PostHog `Bug Report Submitted` counts vs `source:user-bug-report` Sentry volume over the window, firing on a shortfall (`<50%` delivered AND `≥3` missing), with thin-sample and read-unavailable guards. This is the standing detector for the "users submitted but it never reached the team" class (the motivating 260622 incident) — distinct from Check A's per-id reconciliation. Code in `scripts/lib/outcomeMonitorChecks.mjs`.
- **Self-health** chronic-degradation escalation: each run summarizes read-path health for `sentry_stats`, `sentry_events`, `posthog_liveness`, and `posthog_tracked` (`ok` / `blind` when creds absent / `fail` when the read errored). A persisted consecutive-degraded counter (`.monitor-state/self-health.json`, restored across runs via `actions/cache` in the workflow) increments when any dependency is blind or fail and resets on a fully healthy run. After **2** consecutive degraded runs (~6h at the 3-hourly cadence), a distinct `:rotating_light:` escalation posts naming blind vs failed dependencies and pointing at `docs/project/SENTRY_TRIAGE.md` plus postmortem `260618_sentry_outcome_monitor_403_underscoped_token` (403 → monitor token lacks `org:read`). Escalation fires once per streak (fresh crossing only); ongoing blindness relies on per-run BLIND lines and the daily digest self-health line. Missing/malformed state fails open (counter=0). `--dry-run` reads state but does not write it. On a hard Sentry read failure the workflow still fails (existing `failure()` Slack step), but self-health runs first so the counter advances and escalation can fire before the throw.

For `invalid/too_large:event`, desktop-main `beforeSend` now emits a local oversized-event probe (`sentry_oversized_event_detected`, ledger-only) when serialized event JSON crosses the stage threshold, with section-size attribution (`extra.<key>`, `breadcrumbs`, `contexts`; names/sizes only) carried in the main-process log line and the skip-breadcrumb on the next delivered event — the ledger records the occurrence only (its schema deliberately persists no rich data). That makes the next spike self-identifying from local logs/diagnostics, while monitor check B still provides the fleet-level spike alert.

NB activation is gated on the repo's default branch: GitHub schedules the cron (and offers `workflow_dispatch`) only once the workflow file exists on `main` — until the next production promotion carries it, the monitor is inert and `verify_setup` cannot be dispatched. Setup validation is built in: run `node scripts/sentry-outcome-monitor.mjs --verify-setup` to check Sentry read access (both the `stats_v2` and org `events` endpoints), PostHog query capability, and Slack webhook reachability. In CI, the workflow maps `secrets.POSTHOG_PERSONAL_API_KEY_READ` to `POSTHOG_PERSONAL_API_KEY`; this key must include PostHog query/events-read capability (annotation-only keys are insufficient for check A).
Until that read-scoped key is provisioned, check A remains BLIND and is reported as such in the daily digest.

#### Monitor Sentry token contract (`SENTRY_MONITOR_AUTH_TOKEN`)

The monitor reads two **org-level** Sentry endpoints — `GET /organizations/{org}/stats_v2/` and `GET /organizations/{org}/events/` — and both require an **`org:read`**-capable token ([stats_v2 docs](https://docs.sentry.io/api/organizations/retrieve-event-counts-for-an-organization-v2/), [events docs](https://docs.sentry.io/api/explore/query-explore-events-in-table-format/)). They do **not** use `event:read` (that scope is for the Issues/Events APIs and the local attachment fetcher, `scripts/fetch-sentry-attachment.ts`).

- **Dedicated secret:** `SENTRY_MONITOR_AUTH_TOKEN` (repo secret), a **User Auth Token** or **Internal Integration** scoped to **`org:read`** only, org `mindstone`, US region. The script (`resolveSentryToken`) prefers it and **falls back** to the shared `SENTRY_AUTH_TOKEN`, logging loudly when it does so.
- **Do NOT reuse the shared `SENTRY_AUTH_TOKEN`** as the primary monitor token. That secret is the release/sourcemap-upload credential (used by `release.yml` ×3 and the mobile build workflows); it carries release/CI scopes, **not** `org:read`, so the monitor 403s on it — this was the 2026-06-18 outage where the monitor ran blind. It is also likely an Organization Auth Token (`sntrys_`), whose scopes are fixed and can't be rescoped to add `org:read`. Rotating/rescoping it has release blast radius; mint a separate read token instead.
- **Failure is self-diagnosing:** `classifySentryHttpError` maps 401 → invalid/expired (rotate), 403 → under-scoped (needs `org:read`; also check token type/org/project/region), 404 → wrong org/region. A 403 in the job log naming `org:read` is the signal to check the monitor token's scope.

Code: `resolveSentryToken` (prefer-dedicated-then-fallback) and `classifySentryHttpError` live in `scripts/lib/outcomeMonitorChecks.mjs`; consumed by `scripts/sentry-outcome-monitor.mjs`. The workflow wires both env vars (`SENTRY_MONITOR_AUTH_TOKEN` primary, `SENTRY_AUTH_TOKEN` transitional fallback) in `.github/workflows/sentry-outcome-monitor.yml`. The `/events/` reads pass the now-required `dataset: 'errors'` query param. The secret is documented (mint-as-operator-action) in `.env.example`. (commit `7481a4c6cf`)

### Tagging Conventions

All Sentry captures should include structured tags for filtering:

| Tag | Description | Examples |
|-----|-------------|----------|
| `area` | High-level area of the app | `startup`, `agent`, `mcp`, `voice` |
| `component` | Specific component/service | `super-mcp`, `auth`, `workspace` |
| `startup_context` | Which startup phase (for startup errors) | `startup`, `preflight`, `app-ready` |
| `source` | Runtime or integration source | `rebel-core` |


### Configuration

Sampling and enablement are controlled via environment variables. See `src/shared/telemetry/sentryConfig.ts`:

| Variable | Purpose |
|----------|---------|
| `SENTRY_DSN` | The Sentry project DSN. **No DSN → Sentry is fully disabled** (and in-app bug reports are rejected). See delivery paths below. |
| `SENTRY_ENABLED` | Enable/disable Sentry (`true`/`false`) |
| `SENTRY_ENVIRONMENT` | Environment tag (`development`, `production`) |
| `SENTRY_TRACES_SAMPLE_RATE` | Performance tracing sample rate (0.0–1.0) |
| `SENTRY_DEBUG` | Enable Sentry debug logging |

In development, Sentry is typically disabled or uses a lower sample rate. In packaged builds, it's enabled with production settings.

#### DSN delivery (post-OSS-scrub, 2026-06)

The DSN is a public identifier (safe to embed in binaries) but is no longer
hardcoded in the repo — the OSS content scrub (`2888e33ae`) made it env-driven.
How each build type gets it:

- **Commercial release builds** (`.github/workflows/release.yml`): the
  `SENTRY_DSN` GitHub secret is injected as `VITE_SENTRY_DSN` /
  `MAIN_VITE_SENTRY_DSN` on all three platform Electron Forge build steps.
  Vite inlines the value into both the main-process and renderer bundles at
  build time (packaged builds use `@electron-forge/plugin-vite` with plain
  Vite configs, so only `VITE_*`-prefixed vars reach `import.meta.env`;
  `getEnvVar` in `sentryConfig.ts` checks raw, `VITE_`, and `MAIN_VITE_`
  keys). At runtime in a packaged app there is no `process.env.SENTRY_DSN`,
  so build-time inlining is the only delivery path. Two guards kill the
  silent-telemetry-dead class (the 2026-06 beta bug-report outage): a
  preflight step fails the build if the secret is empty, and
  `scripts/check-built-bundle-sentry-dsn.mjs` fails the build if either built
  bundle lacks the DSN marker. CI jobs that *run* the packaged app
  (boot-smoke, E2E, perf) set runtime `SENTRY_ENABLED=0` to suppress sends.
- **Local dev**: off by default (no DSN in env). To test Sentry, set
  `SENTRY_DSN` and `SENTRY_ENABLED=1` in `.env.local`.
- **OSS builds**: never read the env DSN — user-supplied via
  `settings.telemetry` only (no-phone-home gate).
- **Cloud-service (Fly.io) and mobile (EAS)** have separate delivery systems
  (Fly secrets / EAS env) — not covered by release.yml.

The general class ("OSS scrub strips commercial config; each stripped item
needs an explicit commercial delivery path") is tracked with a per-item
status table and outstanding owner actions in the internal
[OSS commercial-config delivery TODO](../../docs-private/ops/OSS_COMMERCIAL_CONFIG_TODO.md)
(internal-only; not present in the public OSS mirror).


### When to Report to Sentry (Decision Matrix)

**AI agents should use this matrix when deciding whether to add Sentry reporting to error handling code.**

#### Send to Sentry (`captureException` / `captureMessage`)

| Criteria | Examples |
|----------|----------|
| **Unexpected** - violates invariant, "should never happen", indicates bug | State machine in impossible state, null where schema says required, protocol handler conflict |
| **User-impacting** - blocks task completion, causes hang/blank screen | Auth callback failures, onboarding dead-ends, file sync failures |
| **Actionable** - we can fix it in code | Code bugs, unhandled edge cases, missing error recovery |
| **Critical flow failure** - auth, sync, onboarding, payments | OAuth callback with no pending auth, token exchange failures |
| **Security events** - potential attacks or anomalies | CSRF state mismatch, unexpected token format |

#### Log Only (do NOT send to Sentry)

| Criteria | Examples |
|----------|----------|
| **Expected + handled** - normal environmental failures | User cancelled, offline with retry UI, permission denied with clear path |
| **High-frequency noise** - transient failures that auto-recover | Retry loops, polling failures, network blips |
| **User-initiated** - deliberate user action caused the "error" | Manual disconnect, cancel button, logout |
| **Privacy risk** - data that can't be confidently scrubbed | User prompts, chat content, workspace paths with usernames |

#### Key Principle

**Instrument critical user-facing flows explicitly** rather than auto-forwarding all `log.error()`. This avoids:
- PII leakage (URLs with auth codes, emails, workspace paths)
- Triage fatigue from transient/expected errors  
- Cost/quota issues from noise

When in doubt, ask: "If this error happens to 100 users, do I need to know about it to fix something?"

### Alerting vs Triage — does this capture page the team?

Capturing to Sentry feeds **two independent systems**, and it's easy to forget the second when picking a `level`:

1. **The triage sweep** — a daily, query-driven pass over the issue stream ([SENTRY_TRIAGE](./SENTRY_TRIAGE.md)). Frequency-based; the triage noise taxonomy decides what's worth a fix.
2. **Sentry alert rules** — fire a **Slack notification in real time** (and, for in-app feedback, a Linear issue). This is a *separate* system that the triage noise taxonomy historically did **not** govern.

**Why this matters when you choose a level:** as of 2026-06 the general alert rule (`Rebel Error`, id 16471532) pages `#rebel-monitoring` on **any issue seen >3×/1h** — and (until the proposed `level ≥ error` filter lands, see below) it does so **regardless of level**. So a new `captureMessage(…, { level: 'warning' })` that recurs more than 3×/hour **will page the team**, even though it's "Log Only"-grade telemetry. The level semantics are codified in [Level semantics & sink policy](#level-semantics--sink-policy-conventions) below.

**Capture-side chokepoint (current state, 2026-06-11):** the chokepoint is the
**known-conditions registry's sink policy inside `captureKnownCondition`** —
`level: 'info'` registry entries declare a `sink`, and `ledger-only` conditions
skip the Sentry capture entirely (wrapper-side, by construction; covers
desktop/cloud/mobile since all share the core wrapper). Raw info-level captures
no longer compile, and raw message captures require an explicit level. There is
deliberately **no** `beforeSend` level-gate — each surface's `Sentry.init`
still has only a redaction `beforeSend` (the sentinel-in-beforeSend design was
refuted: capture-context top-level keys are dropped by `Scope.update()` in
`@sentry/core` 10.42.0; see `docs/plans/260610_improve-sentry-noise/PLAN.md`
Amendments #1). Alert-rule scoping is a separate, outward action — the proposal
lives in `docs/plans/260610_improve-sentry-noise/OUTWARD_PROPOSAL.md` and
[SENTRY_TRIAGE § Alert-Rule Hygiene](./SENTRY_TRIAGE.md#alert-rule-hygiene-what-pages-the-team-vs-what-the-sweep-catches).

### Level semantics & sink policy (conventions)

Codified 2026-06-10/11 ([260610_improve-sentry-noise](../plans/260610_improve-sentry-noise/PLAN.md), Stages 2–6). These conventions are enforced by construction where possible; the enforcement mechanism is named per rule.

#### Level semantics

| Level | Meaning | Delivery |
|---|---|---|
| `info` | **Telemetry. Never an alertable issue.** | Must be a registry condition declaring a `sink`: `ledger-only` skips Sentry by construction; `issue-stream` is an explicit, reviewed exception. Raw info-level captures **do not compile**. |
| `warning` | Degraded-but-handled. | Issue stream; sweep-visible; non-paging under the proposed level-filtered alert rule — the daily triage sweep is the documented backstop for slow-burn warnings. |
| `error` / `fatal` | Defects. | Issue stream; page-worthy (the alert rule's intended scope). |

#### The sink policy (capture-side chokepoint)

`ConditionMeta` (in `src/core/sentry/knownConditions.ts`) is a discriminated union on `level`: an `info` entry **must** declare `sink: 'ledger-only' | 'issue-stream'` (un-adjudicated info entries fail to compile), and `sink` is forbidden on `warning`/`error` entries (their Sentry delivery is implied). `captureKnownCondition` skips the Sentry capture entirely for `ledger-only` conditions — the on-device ledger mirror (which precedes the decision, unconditionally) is the sink, plus a best-effort skip breadcrumb. The skip is fail-open (a malformed registry entry can only cause an extra send, never a silent drop) and the `KNOWN_CONDITION_WRAPPER_DISABLED=1` kill switch bypasses it. Because the skip lives in the shared core wrapper, desktop, cloud, and mobile are all covered; the **renderer has no registry path** (no wrapped captures, no ledger writer — a known parity gap).

`sink: 'issue-stream'` is for info conditions whose fleet-level Sentry visibility is the point — e.g. `cloud_self_update_credentials_missing`, where the grouped issue's event count is the "cohort stuck without credentials" signal and the cloud service has no diagnostic ledger.

#### What ledger-only persistence actually keeps

- The diagnostic-events ledger records **only `{condition, level}`** — `extra`/`tags` payloads are NOT persisted on-device.
- The capture-context `extra` is spread into the **skip breadcrumb's `data`** (best-effort), so it rides onto the **next real Sentry event** — it is context, not a queryable record. Caller `tags` are **not threaded** onto the skip breadcrumb (ledger-only conditions never reach Sentry, so there is no `condition` tag on the wire for that path).
- Consequence: a condition with diagnostically-valuable payloads must stay `issue-stream` or be re-leveled to `warning` (this is why `recovery_pipeline_long_context_fallback_failed` was re-leveled rather than made ledger-only).
- All conditions share one `known_condition` ledger kind cap (`MAX_EVENTS_PER_KIND`, `src/core/services/diagnostics/manifest.ts`) — a high-frequency ledger-only condition can evict rarer conditions' entries on-device.
- Schema drift on a ledger-only condition does NOT skip silently: schema validation runs before the skip decision, and its fallback is a **raw capture at Sentry-default `error`** — louder than the condition ever was, by design (fail-loud).

#### Raw message captures require an explicit, non-info level

`getErrorReporter().captureMessage` and `captureMainMessage`/`captureMainMessageWithLogs` take `ErrorReporterMessageCaptureContext`, whose `level` is **required** and excludes `'info'` (`RawCaptureSeverityLevel`). Rationale: Sentry silently defaults a level-less `captureMessage` to `'info'`, invisible to every guard — the omitting site is a de-facto info event nobody adjudicated (this is how the Ollama crash-loop report shipped as info). `captureException` keeps an optional level (Sentry's default for exceptions is `'error'`, which is correct). An eslint backstop (`rawInfoCaptureGuardSelectors` in `eslint.config.mjs`, next to the LOCKSTEP family) catches literal `level: 'info'` smuggled through casts across `src/core/**`, `src/main/**`, `cloud-service/src/**`; known residual gaps (string-keyed `'level'`, `scope.setLevel('info')`, variable-passed levels) are accepted best-effort since the type guard is primary.

#### Delivery-policy snapshot guard

The known-conditions snapshot (`scripts/data/known-conditions.snapshot.json`) tracks each condition's **`level` and `sink`** in addition to lifecycle dates. A silent re-level or sink flip (e.g. `issue-stream` → `ledger-only`) fails `npm run validate:known-conditions` with a `level-or-sink-mismatch` violation until the snapshot is regenerated — making every delivery-policy change a reviewable snapshot diff, not a one-character registry edit.

#### Fleet-promote + new captures (added 2026-06-21, Stage 6)

Closing Class B/F gaps from the detection-gap investigation (`docs/plans/260621_error-monitoring-detection-gaps/FINDINGS.md`):

- **`fd_pressure_elevated` promoted `info`/`ledger-only` → `warning`.** The fd-leak incident (REBEL-66M) had this early-warning signal but it was invisible to the fleet, so the leak was diagnosed only after the user ran `lsof` against prod. Volume is bounded by the caller-side once-per-band-per-launch guard (≤2 events/launch across the 50/75 bands) and most users never cross 50%, so the issue-stream cost is small vs the early-warning value. (`fd_pressure_critical` at 90% was already `warning`.)
- **`cloud_connection_degraded` deliberately NOT promoted.** It stays `ledger-only`: the `cloud_connection_degraded_escalated` sibling (`warning`) already carries fleet visibility for the case that matters (sustained degradation). Promoting the base healthy→degraded edge-trigger would re-introduce flap noise — the opposite of the Class F goal. The FINDINGS lumped it with `fd_pressure` but didn't account for the escalated sibling.
- **fd-context on spawn failures (REBEL-66M).** `bundledHttpMcpManager`'s child `spawn`-error handler now attaches an fd-pressure snapshot breadcrumb (open-fd count + highest fd number, structural/no-PII, via `readFdPressure()`), so a `spawn EBADF`-class failure that is really fd exhaustion is self-evident on the captured event instead of being misdiagnosed as a stdio bug.
- **`corrupt_session_file_skipped` (H2).** `incrementalSessionStore.loadSessionFile` / `loadSessionFileSync` previously swallowed a corrupt/unreadable (non-ENOENT) session file to a SILENT null — the session vanished from the visible corpus with no signal. Now `warning`-level + `warn` log, fingerprinted by operation; counts/operation only (PII-safe by a `.strict()` `{operation, errorCode}` schema). ENOENT (a legitimately-absent file) stays silent.
- **MCP config-parse capture (M3).** `mcpService.getConnectedPackages` now calls `reportMcpError` (warning, `mcp_error_kind: 'config_parse_failed'`) when a CORRUPT MCP config silently drops all tool awareness from the system prompt; a missing config (ENOENT — new users / no managed config) stays warn-only.
- **Route-failure attribution (`ai_error_shown`)** was already implemented (FOX-3494 #5: `routeInvalidReason` / `failedRouteRole` / `unsupportedModelId` in `agentEventDispatcher.ts`) — verified present, not re-added.
- **Deferred:** demoting the REBEL-603 "rate limit reached" noise (3,913 events / 219 users) — the FINDINGS line-reference (`recoveryAdapter.ts:254`) has drifted and the precise Sentry-issue→code-site mapping overlaps γ's `classifySessionError` server-error fragmentation work; it belongs to the alerting-layer (γ) `OUTWARD_PROPOSAL` rather than a blind code demotion here.

#### Dedup / rate-limit pattern menu (no shared helper — by decision)

Capture sites that can storm use one of these existing idioms — pick the one whose semantics match; **do not build a shared cooldown helper** (decision 260610, PLAN Research Notes #6: the 7 idioms have genuinely different semantics, no current storm class needs unification, and server-side backstops — the 2,000/min DSN key rate limit + org spike protection + the sink policy — already bound the blast radius. Revisit only if an 8th distinct class appears.)

1. **Per-session LRU + time window** — `shouldCaptureCodexBtsDisconnect` (codex BTS disconnect: per-session dedupe + 5-min unscoped window).
2. **Caller-side trigger gating** — watchdog stalled: captured only on first trigger level, suppressed while a tool is in flight or the stream is emitting deltas (`agentTurnExecute.ts`).
3. **Edge-triggered state transitions** — `cloudFailureCooldown` observability hooks: once per healthy→degraded edge / escalation-level crossing.
4. **Once-per-process latch** — `cloud_pressure_capability_missing` (module-level latch); `selfUpdateScheduler` `capturedCauses` (once per cause per process).
5. **Persistent on-disk marker** — `cloud.image_rollback.recovered` (`/data/.rollback-reported.json`, dedupes across boots).
6. **Time-window cooldown store** — unclean-shutdown report (1-hour cooldown, `crashRecoveryService.ts`).
7. **Capped report budget** — logger transport errors (`MAX_TRANSPORT_ERROR_REPORTS` counter, `src/core/logger.ts`).

### Adding New Error Captures

When adding new Sentry captures:

1. **Check the decision matrix above** - only report errors that meet the "Send to Sentry" criteria

2. **Import the capture function**:
   ```typescript
   import { captureMainException, captureMainMessage } from '../sentry';
   ```

3. **Use `captureMainException` for actual errors**:
   ```typescript
   captureMainException(error, {
     tags: { area: 'your-area', component: 'your-component' },
     extra: { /* additional context - no PII! */ }
   });
   ```

4. **Use `captureMainMessage` for non-exception issues** (anomalies, warnings):
   ```typescript
   captureMainMessage('Description of the issue', {
     level: 'warning', // REQUIRED; 'error'/'fatal' also allowed — 'info' does not compile
     tags: { area: 'your-area', component: 'your-component' }
   });
   ```
   The context (with an explicit `level`) is required — see [Level semantics & sink policy](#level-semantics--sink-policy-conventions). Info-grade telemetry goes through `captureKnownCondition` or a breadcrumb instead.

5. **Apply consistent tags** using the conventions above

6. **Never include PII in `extra`**: No emails, no user paths, no auth codes, no chat content


### Known Condition Registry

For categorisable structured error classes that recur across the codebase, Mindstone Rebel uses `captureKnownCondition` — a typed wrapper over `getErrorReporter().captureException` backed by an append-only registry. The wrapper mechanically enforces stable Sentry fingerprints: the same condition name always maps to the same fingerprint array regardless of high-cardinality error message content. This prevents the fingerprint fragmentation pattern documented in two postmortems ([260424 ModelError postmortem](../../docs-private/postmortems/260424_sentry_model_error_fingerprint_fragmentation_postmortem.md) and [260427 CodexDisconnectedBtsError postmortem](../../docs-private/postmortems/260427_codex_disconnected_bts_sentry_fragmentation_postmortem.md)). On the wrapped issue-stream path, every captured event also carries a queryable Sentry tag `condition: <conditionName>` (authoritative registry key, independent of fingerprint), so alert rules and searches can scope to a specific condition — not just shared caller `area`/`component` tags. Ledger-only conditions still skip Sentry entirely (no tag on the wire).

#### When to use it

- Capturing an instance of a `KnownStructuredError` subclass (`ModelError`, `CodexDisconnectedBtsError`)
- Capturing a categorisable runtime condition where stable Sentry coalescence matters (vs default group-by-message)
- When you need an `expectedDegraded` window with mechanical expiry to prevent sticky-suppression
- NOT for: truly unexpected exceptions; renderer-layer captures; one-off diagnostic captures

#### How to use it

```typescript
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';

// ModelError — dynamic-fingerprint callback in registry
captureKnownCondition('model_error', { kind: 'rate_limit', provider: 'anthropic', upstreamProvider: 'aws-bedrock' }, error);

// CodexDisconnectedBtsError — static fingerprint
captureKnownCondition('codex_disconnected_bts', { sessionId, caller: 'callBehindTheScenes' }, error);
```

#### Adding a new condition

1. Add new entry to [`src/core/sentry/knownConditions.ts`](../../src/core/sentry/knownConditions.ts) (`KNOWN_CONDITIONS`). `level: 'info'` entries must declare a `sink` (the type enforces it) — see [Level semantics & sink policy](#level-semantics--sink-policy-conventions).
2. Run `npm run regenerate:known-conditions-snapshot` to update `scripts/data/known-conditions.snapshot.json` (the snapshot also pins `level`/`sink`, so re-levels and sink flips show up as snapshot diffs).
3. Update the tag-based selector regex in [`eslint.config.mjs`](../../eslint.config.mjs) (the `value.value=/^(...)$/` alternation just below the `// LOCKSTEP-ANCHOR:` comment) to include the new condition. The CI parity check (`npm run validate:known-conditions`, included in `validate:fast`) enforces this — adding a condition without updating the regex fails CI with a `members-out-of-lockstep` sub-kind error.
4. Commit registry + snapshot + lint regex together.
5. (Migrating an existing capture site) Replace `getErrorReporter().captureException(...)` with `captureKnownCondition(condition, context, error)`.

#### Lint guards

Two ESLint selectors in `eslint.config.mjs` enforce wrapper usage in core/main-service/cloud layers:

- **Literal-class selector** (Wave 1): catches `captureException(new ModelError(...))` and `captureException(new CodexDisconnectedBtsError(...))`.
- **Tag-based selector** (Wave 2): catches `captureException(err, { tags: { condition: '<KnownCondition>' } })` literal patterns. The selector uses descendant matching, so spread-with-inline-tags shapes like `captureException(err, { ...base, tags: { condition: 'model_error' } })` also fire.

**Known static-selector bypasses (caught by Layer-2 runtime guard):**

- **Variable-passed context object**: `const ctx = { tags: { condition: 'model_error' } }; captureException(err, ctx)` — the relevant Property is not a direct descendant of the `captureException(...)` call's argument.
- **Computed property key**: `captureException(err, { tags: { ['condition']: 'model_error' } })` — `[key.name='condition']` does not match computed keys.
- **Template literal value**: `captureException(err, { tags: { condition: \`model_error\` } })` — `[value.type='Literal']` does not match `TemplateLiteral`.

These are intentional static-selector gaps. The Layer-2 runtime guard in [`src/core/errorReporter.ts`](../../src/core/errorReporter.ts) catches all three at runtime via `Object.hasOwn(KNOWN_CONDITIONS, conditionTag)` — emitting a Pino warn that surfaces during testing or staging before any unwrapped capture reaches Sentry. `scripts/check-known-conditions.ts` (`checkLintRegexParity`) verifies the tag-selector regex stays in lockstep with `KNOWN_CONDITIONS`; the parity check anchors regex extraction on a `// LOCKSTEP-ANCHOR:` comment marker just above the tag-based selector, so casual reformatting cannot accidentally break the check. The parity check fails fast with sub-kinds `anchor-missing`, `regex-not-found-after-anchor`, or `members-out-of-lockstep` so failures are unambiguous. Rare overrides must be explicit:

```ts
// eslint-disable-next-line no-restricted-syntax -- captureException-justified: <reason>
```

#### Manual cross-surface coalescence smoke test

Sentry coalescence relies on the wrapper emitting an identical canonical fingerprint from every surface. The CI parity check guards the static lint regex, but the actual *grouping* behaviour is a runtime property of the live Sentry project. Re-run this manual smoke test after any change to the wrapper, the registry fingerprints, or the cross-surface adapters (`src/main/sentry.ts`, `cloud-service/src/bootstrap.ts`, `mobile/src/utils/sentry.ts`):

1. In a controlled environment (staging / dev DSN), emit one capture per surface:
   - **Desktop**: launch the dev app and trigger `captureKnownCondition('model_error', { kind: 'rate_limit', provider: 'anthropic', upstreamProvider: 'aws-bedrock' }, new ModelError('smoke-test'))` from a temporary debug menu / scratch handler.
   - **Cloud**: hit a temporary dev endpoint that calls the same `captureKnownCondition('model_error', ...)`.
   - **Mobile**: use a debug build to invoke the same call from React Native.
2. In the Sentry UI (filtered by the staging DSN, time-range narrowed to the smoke-test window), confirm all three captures land in **one** issue group with the canonical `model_error` fingerprint and platform tags `desktop` / `cloud` / `mobile` distinguishing them inside the group.
3. Repeat for any other registry condition you've changed (`codex_disconnected_bts`, `runtime_activity_mapper_failure`, `cloud_outbox_stuck`).

If the captures fragment into multiple groups, surface differs in fingerprint emission — typically a missed wrapper invocation, a divergent `errorReporter.ts` adapter, or stale Sentry SDK overrides. This smoke test replaces the previously-considered CI instrumentation (Discovered Improvement #4 in [`260503_capture_known_condition_full_migration.md`](../plans/260503_capture_known_condition_full_migration.md)) which was scoped out as too high-cost for the observed risk.

#### Deprecating or renaming a condition

1. Add new condition with `addedAt: <today>`.
2. Mark old condition `deprecatedAt: <today>` (helper auto-fills `removableAfter = deprecatedAt + 30d`).
3. Migrate call-sites from old → new (both names typecheck during deprecation).
4. Run regenerate-snapshot, commit.
5. After `removableAfter` passes, remove old entry, regenerate snapshot, commit.

#### `expectedDegraded` flow

When a known condition is operating in a temporary "expected degraded" mode (e.g. waiting on a third-party fix), set `expectedDegraded: { until: '2026-Q2-01T00:00:00Z', reason: 'Anthropic flow-control rollout — re-evaluate Q3' }` on the registry entry. CI fails if `until` passes; warns 7 days before. Forces re-evaluation rather than letting suppression become permanent. See `scripts/check-known-conditions.ts`.

#### Wrapper fail-safe contract

The wrapper **never throws**. Falls back to vanilla `captureException` on registry-miss or schema-fail. Falls back to static `[condition]` fingerprint on dynamic-callback-throw. Reporter (Sentry adapter) throws are swallowed. All failures emit Pino warns. See [`src/core/sentry/captureKnownCondition.ts`](../../src/core/sentry/captureKnownCondition.ts) for the per-failure-mode contract.

#### Architecture

Three enforcement layers:
- **Layer 1 (compile-time/lint):** narrow `no-restricted-syntax` selectors in `eslint.config.mjs` block literal known-condition capture patterns in `src/core/`, `src/main/services/`, `cloud-service/src/`.
- **Layer 2 (runtime guard):** [`src/core/errorReporter.ts`](../../src/core/errorReporter.ts) adapter inspects each `captureException` call — if it sees a known structured error or `tags.condition` and the wrapper sentinel is missing, emits Pino warn (cross-surface, non-blocking).
- **Layer 3 (CI):** `scripts/check-known-conditions.ts` enforces append-only invariant, `expectedDegraded` expiry, and lint-regex parity against the live registry.

#### Cross-references

- [260424 ModelError postmortem](../../docs-private/postmortems/260424_sentry_model_error_fingerprint_fragmentation_postmortem.md)
- [260427 CodexDisconnectedBtsError postmortem](../../docs-private/postmortems/260427_codex_disconnected_bts_sentry_fragmentation_postmortem.md)
- [Planning doc: Sentry capture contract (Wave 1)](../plans/260503_sentry_capture_contract.md) — full design rationale, literal-class lint guard
- [Planning doc: `captureKnownCondition` full migration (Wave 2)](../plans/260503_capture_known_condition_full_migration.md) — tag-based lint generalization, Layer-2 hardening, CI parity check
- [`src/core/sentry/knownConditions.ts`](../../src/core/sentry/knownConditions.ts) — registry
- [`src/core/sentry/captureKnownCondition.ts`](../../src/core/sentry/captureKnownCondition.ts) — wrapper

### Fingerprint Disambiguation Patterns (REBEL-T4)

When a single Sentry issue groups disparate error shapes that need to be separated into sub-issues, use a **secondary structural discriminator** added to the fingerprint. This pattern applies beyond `captureKnownCondition` — it is the general template for any overgrouping problem in Sentry.

**REBEL-T4 pattern for `AgentSessionError`**:

The renderer-side `AgentSessionError` uses `buildAgentSessionErrorFingerprint` (`src/renderer/features/agent-session/utils/classifySessionError.ts`) to build fingerprint tuples:
- **2-tuple** (default): `['AgentSessionError', errorCategory]` — when `structuralKind` is absent or unknown; an 80-char message-prefix serves as the tertiary discriminator for truly unknown cases
- **3-tuple**: `['AgentSessionError', errorCategory, structuralKind]` — when `structuralKind` is known; groups structurally-similar errors across different message content

This is the general pattern for "split a single Sentry issue into sub-issues via a secondary structural discriminator." To apply this pattern for a new error class: pick the structural field that best distinguishes the error shapes (e.g., `structuralKind`, `errorKind`, `phase`, `source`) and append it as the third fingerprint slot. The first slot is the error-class name, the second slot is the error category.

See [260510 rebel_t4 fingerprint disambiguation](../plans/260510_rebel_t4_fingerprint_disambiguation.md) and [260510 rebel_t4 followups](../plans/260510_rebel_t4_followups.md).


### Automated Sentry Triage

A daily CI workflow triages Sentry issues and optionally triggers automated fixes:

- **Workflow**: [`.github/workflows/sentry-triage.yml`](../../.github/workflows/sentry-triage.yml) — runs at 4pm UTC daily
- **Triage process**: Uses Droid CLI with the Sentry MCP to analyze recent issues per [SENTRY_TRIAGE.md](./SENTRY_TRIAGE.md)
- **Auto-fix pipeline**: High-priority issues are written to `sentry-triage-fixes.json` at repo root; the workflow spawns parallel fix sessions (up to 5) that create PRs

Triage logs are committed to `docs-private/sentry-triage-log/` and summaries are posted to Slack.


### Maintenance

#### Sentry SDK Version Policy

To avoid runtime mismatches, we keep **one** Sentry JavaScript SDK version across the `@sentry/*` packages we ship.

- `@sentry/electron` is **pinned** (no caret) in `package.json`
- The Sentry JS SDK packages are **forced** via `package.json` `overrides` (`@sentry/core`, `@sentry/browser`, `@sentry/node`, `@sentry/react`, and any other `@sentry/*` that needs to stay aligned)
- When updating Sentry, update the pinned versions **and** the overrides together

To verify what is installed:

```sh
npm ls @sentry/electron @sentry/core @sentry/browser @sentry/node @sentry/react
```


- When adding new startup monitoring, update the "Startup Error Monitoring" section above
- Keep tagging conventions consistent across the codebase
- Review [SENTRY_TRIAGE.md](./SENTRY_TRIAGE.md) if noise patterns emerge from new captures
- If changing Sentry configuration, update this doc and `SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md` together
