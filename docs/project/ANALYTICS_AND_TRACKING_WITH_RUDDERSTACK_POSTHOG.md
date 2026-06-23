---
last_updated: "2026-05-14"
description: "How analytics and tracking work in Mindstone Rebel: RudderStack integration, identity, initialization, configuration, event APIs, privacy safeguards, diagnostics, and Sentry error telemetry."
---

### Introduction

This document explains how Mindstone Rebel implements analytics and tracking across the Electron Main and Renderer processes. It covers the RudderStack integration (behavioral analytics), identity model, configuration and enable/disable behavior, the event APIs used throughout the app, privacy guards, and the relationship with Sentry (error/perf telemetry).

### See also

- **[ANALYTICS_DATA_DICTIONARY.md](./ANALYTICS_DATA_DICTIONARY.md)** – Comprehensive catalog of all analytics events with properties, business value, and gotchas.
- `src/main/analytics.ts` – Main‑process RudderStack client, anonymous ID storage, health/status, and helpers.
- `src/core/tracking.ts` – Platform-agnostic `Tracker` interface; each platform wires its implementation at bootstrap.
- `src/main/tracking.ts` – Main‑process tracking helpers (lifecycle, file ops, metrics aggregator).
- `src/renderer/src/analytics.ts` – Renderer RudderStack client and helper APIs.
- `src/renderer/src/tracking.ts` – Higher‑level event wrappers used by UI/feature code.
- `src/main/index.ts` – App lifecycle events, identity sync IPC, flush on quit.
- `src/preload/index.ts` – `electronEnv` bridge for anonymous ID, runtime config, and identity sync.
- `src/shared/ipc/contracts.ts` – IPC contract; see `analytics:status`.
- `src/shared/trackingTypes.ts` – Types and utilities (traits, event metrics, session hashing).
- `docs/plans/finished/251120_Integrate_rudderstack.md` – Implementation plan and rationale.
- `docs/plans/finished/251125_RudderStack_event_tracking_plan.md` – Draft event taxonomy and traits.
- `docs/plans/finished/251122_Analytics_DISABLED_sentinel_and_settings_tabs.md` – `DISABLED` sentinel and status semantics.
- `docs/plans/finished/260122_analytics_audit_recommendations.md` – Analytics audit findings and recommendations (Jan 2026).
- `docs/project/ARCHITECTURE_OVERVIEW.md` – Notes on analytics and runtime configuration.
- `docs/project/LOGGING.md` – Structured logging (separate from analytics), where logs go, how to debug.
- `config/app-config.json` / `config/app-config.template.json` – Runtime config + env variable mapping.
- `scripts/generate-runtime-config.mjs` – Builds `app-config.json` from env.

### Principles, key decisions

- **Main‑process‑first identity**: A stable anonymous ID is generated once and persisted in the main process, then passed to the renderer. Both processes use the same identity.
- **Opt‑out by default unless configured**: Analytics is disabled unless valid RudderStack credentials are provided via runtime config or environment variables.
- **Single source of truth for enablement**: A `DISABLED` sentinel disables analytics everywhere (main and renderer). Missing/empty values also disable analytics.
- **Safe no‑ops**: All track/identify calls are guarded; when disabled or unhealthy, they no‑op.
- **Minimal PII by default**: Events use anonymous IDs; optional user traits (e.g., email) are set explicitly after successful, user‑initiated retrieval.
- **Error telemetry is separate**: Sentry is used for errors/profiling and is configured independently from RudderStack analytics.

### Architecture overview

1) Main process (Node, RudderStack Node SDK)
- File: `src/main/analytics.ts`
- Generates and persists a stable `anonymousId` using `electron-store` (`analytics-storage`).
- Resolves RudderStack credentials from runtime config/env via `resolveConfigSecret`.
- Initializes a Node SDK client when both values are present and not `DISABLED`.
- Performs a one‑off config probe at launch by sending `RudderStack Config Check`:
  - Classifies status as `disabled` | `pending` | `healthy` | `error`.
  - Exposes status via `getAnalyticsStatus()` and IPC `analytics:status`.
- Provides helpers:
  - `trackMainEvent(payload)` – guarded track.
  - `identifyMainUser(payload)` – guarded identify.
  - `flushMainAnalytics()` – drain queue before quit.

2) Renderer process (Browser, RudderStack JS SDK)
- File: `src/renderer/src/analytics.ts`
- Reads secrets from `window.electronEnv.runtimeConfig` (preload bridge) and uses the same `anonymousId` from `window.electronEnv.anonymousId`.
- Calls `analytics.init()` during boot (`src/renderer/main.tsx`), then `analytics.track('Renderer Boot', …)`.
- Disables auto‑generation of anonymous IDs (`setAnonymousId: false`) and sets the value supplied by the main process.
- Exposes:
  - `analytics.track(event, properties?)`
  - `analytics.identify(userId, traits?)`
  - `analytics.identifyEmail(email, { userId?, traits? })`
  - When identify is called in the renderer, the identity is also forwarded to the main process via `electronEnv.syncAnalyticsIdentity` → `ipcMain.on('analytics:identify')`.

3) Preload and IPC
- File: `src/preload/index.ts`
  - Exposes `window.electronEnv` with:
    - `anonymousId` and `appVersion` passed as `additionalArguments` to the renderer.
    - `runtimeConfig` getter and `reloadRuntimeConfig()` for on‑demand refresh.
    - `syncAnalyticsIdentity({ userId, traits })` → forwards to main for unified identity.
  - Exposes `window.api.getAnalyticsStatus()` which uses the `analytics:status` invoke channel.
- File: `src/shared/ipc/contracts.ts`
  - `miscChannels['analytics:status']` returns `{ state, enabled, error }`.

### Mobile (React Native / Expo)

Mobile analytics is **client-side RN instrumentation**, not a flip of a server-side tracker. Added 2026-06-12 (greenfield — see `docs/plans/260612_mobile-analytics-error-monitoring/PLAN.md`). Code lives under `mobile/src/analytics/` — start at `mobile/src/analytics/tracking.ts` (the typed event taxonomy) and `mobile/src/analytics/analytics.ts` (the gated RudderStack RN singleton).

**Why client-side, not via `@core/tracking`.** Mobile's business logic runs on the user's **cloud instance**, whose `getTracker()` emits the core/agent-lifecycle events. The desktop's richest events are renderer-only. So wiring a *cloud* tracker would not capture mobile UI behaviour, and the cloud no-op tracker (`cloud-service/src/bootstrap.ts`) would drop it entirely. Mobile therefore uses the **RudderStack React Native SDK** (`@rudderstack/rudder-sdk-react-native`) directly in the app — never the Node SDK and never `@core/tracking`. The mobile event types stay mobile-local (not added to `src/shared/trackingTypes.ts`).

- **Always-on + identified by email** (matches desktop's commercial build): no in-app opt-out toggle, no consent persistence, no first-run gate. Disclosed in the privacy policy and a "Privacy" card in `mobile/app/(tabs)/help.tsx`. A non-user **kill-switch** env flag is retained for incident response; `isAnalyticsPermitted()` = creds present AND kill-switch off. The user decision and rationale are in the PLAN.md Decision Log (2026-06-12 13:40).
- **One-emitter-per-event partition (no double-counting).** Because a mobile-driven session also runs on cloud (which emits core/agent events), mobile emits **only client/UI-origin events** that core does NOT emit (verified disjoint). Core/agent/tool/cost/memory events come from the cloud instance, never mobile. See the [Mobile Events section of the data dictionary](./ANALYTICS_DATA_DICTIONARY.md#mobile-events-react-native-client) for the per-event client-origin verification.
- **Taxonomy:** ~8-12 intentionally-boring events (App Opened/Backgrounded, Pair lifecycle, Screen Viewed, Message Sent, Voice Recording Completed, Approval Resolved, Inbox Action Tapped). Every event carries `client_surface: 'mobile'` (non-overridable) — the shared cross-surface dimension (desktop/cloud/mobile), distinct from the overloaded per-event `surface` and the tool-origin `source_surface`. Full catalog: `mobile/src/analytics/tracking.ts` + the data dictionary.
- **`anonymousId` = the shared `rebel_client_id`** — reconciled with cloud-client's `getOrCreateClientId()` (`cloud-client/src/auth/createAuthStore.ts`, first-writer-wins), never a fresh UUID, so mobile analytics and the rest of the client agree on identity.
- **Identity:** `identify(email)` on pair (email is the SDK userId, matching desktop; fetched once from `cloudClient.getSettings().userEmail`, shared with the Sentry identify), SDK `reset()` to anonymous on unpair. Graceful degradation to anonymousId-only when email is absent (logged, not silent).
- **Privacy contract + redaction:** the IDFA-free config (`autoCollectAdvertId:false`, `collectDeviceId:false`), forbidden-key/recursive PII redaction, and the no-direct-SDK-import rule are codified in `mobile/src/analytics/redaction.ts` and `mobile/src/analytics/PRIVACY_CONTRACT.md`, enforced by a static guard + Jest tests. No message content, raw URLs, emails-as-properties, or file paths ever ride on an event.
- **Key delivery (write key + data-plane URL):** unlike desktop's `config/app-config.json` flow (below), mobile reads `EXPO_PUBLIC_RUDDERSTACK_WRITE_KEY` / `EXPO_PUBLIC_RUDDERSTACK_DATA_PLANE_URL` baked into the EAS build. The mobile CI workflows sync these (same RudderStack workspace as desktop/cloud) from GitHub secrets into the EAS `production` environment before each build — see [MOBILE_TELEMETRY_KEYS.md](./MOBILE_TELEMETRY_KEYS.md). Locally the vars are absent by design, so analytics stays inert.

For App Store / Play privacy declarations and the privacy-manifest story (shared with Sentry), see [ERROR_MONITORING_AND_SENTRY.md § Mobile](./ERROR_MONITORING_AND_SENTRY.md#mobile-react-native--expo).

### Configuration and enable/disable behavior

- Secrets are provided via `config/app-config.json` (generated from `config/app-config.template.json` by `scripts/generate-runtime-config.mjs`).
- Keys:
  - `analytics.rudderstack.writeKey`
  - `analytics.rudderstack.dataPlaneUrl`
- `DISABLED` sentinel:
  - The exact string `DISABLED` disables analytics where it appears for RudderStack credentials.
  - Missing/empty values also mean “analytics off”.
- Environment variables:
  - Template defaults to `{{ env.RUDDERSTACK_WRITE_KEY }}` and `{{ env.RUDDERSTACK_DATA_PLANE_URL }}`.
  - Use `DISABLED` in `.env` (or leave unset) to keep analytics off locally/CI.

#### Runtime disable via environment variable

Set `DISABLE_ANALYTICS=true` (or `1`) to completely disable analytics at runtime. This is useful for:
- Local packaged builds during development
- CI E2E test runs to avoid polluting production data
- Any scenario where you want to temporarily disable tracking

This takes precedence over RudderStack credentials - even with valid credentials, analytics will be disabled if this variable is set.

### Identity and traits

- Anonymous identity:
  - Main process generates a UUID once and stores it under `analytics-storage`.
  - Passed to the renderer at window creation via `--anonymous-id` command line arg.
  - Both processes use the **same** `anonymousId` for consistent identity.
- Traits:
  - Main process periodically sets traits reflecting app/config state (version, platform, build channel, voice provider, MCP mode, etc.). See `mainTracking.identifyUser`.
  - Renderer can also set traits via `tracking.identifyUser` (wraps `analytics.identify` with the shared anonymous ID).
- Optional user email:
  - `src/main/services/userProfileService.ts` may retrieve `userEmail` via Klavis MCP (user‑initiated) and calls `identifyMainUser` with `{ traits: { email } }`.
  - Renderer `analytics.identifyEmail(email)` is also available; it synchronizes the identity back to the main process.

### Identity linkage across processes

To ensure all events from both processes are attributed to the same user in PostHog:

1. **Shared anonymousId**: Main process generates the ID and passes it to renderer via `--anonymous-id`. Both processes use this same ID.

2. **Alias on identification**: When a user's email becomes known, both processes call `alias(email, anonymousId)` to permanently link the anonymous profile to the authenticated user profile. This is done:
   - In main: automatically inside `identifyMainUser()` (one-time, callback-guarded)
   - In renderer: inside `analytics.identifyEmail()` (one-time, flag-guarded)

3. **UserId in track events**: After identification, main process automatically includes `userId` in all `trackMainEvent()` calls via a cached value. This ensures events are properly attributed even if alias hasn't propagated yet.

4. **Logout handling**: On logout, `clearKnownUserId()` clears the cached userId so subsequent events don't mis-attribute. The `hasAliased` flag is NOT reset (profiles are permanently merged).

**Important assumptions**:
- **Single-user per install**: Aliasing permanently merges profiles. If a different user logs into the same device, their events may be attributed to the first user's profile.
- **PostHog backfill**: Events sent before alias (e.g., `Application Opened` at startup) are retroactively attributed to the merged profile.

**Debug logging**: Set `DEBUG_ANALYTICS=1` in non-production environments to see `[analytics] track:` and `[analytics] alias:` logs showing identity state.

### Event APIs and usage

- Core helpers:
  - Main: `trackMainEvent`, `identifyMainUser` (guarded by healthy status).
  - Renderer: `analytics.init`, `analytics.track`, `analytics.identify`, `analytics.identifyEmail` (no‑ops if disabled).
- UI‑level wrappers:
  - Use `src/renderer/src/tracking.ts` instead of direct `analytics.track` where possible. It provides organized categories (onboarding, chat, tools, automations, voice, inbox, contextualDashboard, settings, workspace) and milestone helpers.
  - Milestones (`first_message_sent`, `first_tool_connected`, etc.) are de‑duped and persisted in `localStorage` to avoid double counting.
- Session privacy:
  - Session IDs are pseudonymized via `hashSessionId` before being sent to analytics.
  - **Known issue:** Renderer and main process currently use different hashing algorithms. See `docs/plans/finished/260122_analytics_audit_recommendations.md` for details.

**For a complete list of all events and their properties, see [ANALYTICS_DATA_DICTIONARY.md](./ANALYTICS_DATA_DICTIONARY.md).**

### Lifecycle events

- On app launch (main): `Application Opened` is sent immediately (when healthy) with version/platform/arch.
- On renderer boot: `Renderer Boot` is sent after `analytics.init()`.
- On graceful quit (main): `Application Quit` is sent, then `flushMainAnalytics()` drains the Node SDK queue.

### Diagnostics: status and health

- Main process maintains analytics status:
  - `disabled` – No keys or `DISABLED` sentinel.
  - `pending` – Client created; startup probe in flight.
  - `healthy` – Probe accepted; client usable.
  - `error` – Probe failed; guarded helpers will no‑op.
- UI can access status via:
  - IPC: `analytics:status` (see `src/main/ipc/miscHandlers.ts` and `src/shared/ipc/contracts.ts`).
  - Preload bridge: `window.api.getAnalyticsStatus()` (or `miscApi.analyticsStatus` in the generated bridge).

### Sentry (error/performance telemetry)

Sentry is used for error and performance telemetry, separate from RudderStack behavioral analytics.

**Canonical reference**: See [ERROR_MONITORING_AND_SENTRY.md](./ERROR_MONITORING_AND_SENTRY.md) for complete Sentry documentation including:
- Architecture (main/renderer initialization)
- Startup error monitoring (Super-MCP failures, auth timeouts)
- Tagging conventions for filtering
- Configuration and environment variables
- How to add new error captures

**Key points**:
- Sentry user identity uses the same `anonymousId` as analytics
- Renderer boot order: `initRendererSentry()` before `analytics.init()` to capture analytics init errors
- Startup failures are automatically captured to diagnose issues users may not report

### Adding new analytics events

1) Prefer `tracking.ts` wrappers in the renderer for UI/feature code. If a new category is needed, add a nested object with succinct event names and clear, flat properties.
2) For main‑process events, use `trackMainEvent` and keep properties small, structured, and free of sensitive content.
3) Keep names consistent and searchable. Use “Object Action” patterns (e.g., `Automation Run Completed`, `Onboarding Step Viewed`).
4) Attach shared context as traits rather than repeating them on every event (platform, version, build channel, etc.).
5) Keep PII out. Only include email/identify if explicitly set by user action.
6) Update [ANALYTICS_DATA_DICTIONARY.md](./ANALYTICS_DATA_DICTIONARY.md) when adding new events — include properties, business value, and source file.

> **This is part of the engineering definition-of-done.** Every new user-facing feature must ship with analytics instrumentation. There is no autocapture — if you don't add the call, the interaction is invisible to product analytics. See also [CODING_PRINCIPLES.md § Analytics and tracking](./CODING_PRINCIPLES.md#analytics-and-tracking).

#### Checklist for new features

- [ ] Identify the key user interactions (views, clicks, completions, errors) that matter for product analytics
- [ ] Add `tracking.*` calls at each interaction point in the renderer (extend the `tracking` object if needed)
- [ ] Add `trackMainEvent` calls for any main-process events (lifecycle, background tasks)
- [ ] Follow "Object Action" naming with Title Case (e.g., `Settings Panel Viewed`, `Connector Connected`)
- [ ] Update `ANALYTICS_DATA_DICTIONARY.md` with new events
- [ ] Verify events appear in PostHog during dev testing (check `window.api.getAnalyticsStatus()` returns `healthy`)

### Troubleshooting

- No events received:
  - Check `window.api.getAnalyticsStatus()` → likely `disabled` or `error`.
  - Verify `config/app-config.json` (or env vars) and avoid `DISABLED`.
  - Confirm the renderer called `analytics.init()` and you see `Renderer Boot`.
- Event names present but missing traits:
  - Ensure `mainTracking.identifyUser(settings)` has run with up‑to‑date settings.
  - If using email identification, verify the Klavis flow or `setUserEmail` completed successfully.
- Quit events missing:
  - Confirm `gracefulShutdown` runs and `flushMainAnalytics()` is awaited (see `src/main/index.ts`).

### Maintenance

- When changing analytics configuration or adding new event categories, keep this doc and the plans up to date.
- Prefer updating/adding to `tracking.ts` for UI instrumentation so event semantics stay centralized and discoverable.
- If you introduce new secrets or runtime config keys, update `app-config.template.json` and `SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md` together, and reflect the `DISABLED` semantics where appropriate.

### Best Practices (from Platform Research)

For detailed platform guidance, see:
- [RudderStack Deep Dive](../research/rudderstack-deep-dive.md)
- [PostHog Deep Dive](../research/posthog-deep-dive.md)

**Key takeaways:**

1. **Flush on shutdown is critical**: The Node SDK queues events; if the app crashes or quits without flushing, events are lost. Always call `flushMainAnalytics()` in shutdown paths.

2. **Profile merging is permanent**: Once `alias()` links an anonymous profile to a known user in PostHog, they cannot be split via API (requires support ticket). This is why we document "single-user per install" as an explicit assumption.

3. **Normalize userId consistently**: PostHog treats `[external-email]` and `[external-email]` as DIFFERENT users. Always lowercase and trim email before sending to RudderStack. The main process does this in `identifyMainUser()`.

4. **Event naming convention**: Use "Object Action" pattern with Title Case (e.g., `Chat Message Sent`, `Automation Run Completed`). Keep property names in camelCase.

5. **Avoid reserved keywords as property names**: Don't use `id`, `user_id`, `anonymous_id`, `event`, `timestamp`, `context`, `properties`, `traits` as custom property names - they conflict with RudderStack/PostHog internals.

6. **Session ID hashing**: Session IDs are hashed before sending for privacy. Use the `hashSessionId()` function from `src/shared/trackingTypes.ts` consistently across both processes.

7. **Anonymous events are cheaper**: PostHog charges ~4x less for anonymous events. If cost becomes a concern for high-volume, low-value events, consider sending them without userId.

### User Engagement Heartbeat

The app sends periodic `User Engagement Heartbeat` events to accurately measure active user engagement, separate from PostHog's session-based metrics (which can be inflated by background automations).

**How it works:**
- Main process sends heartbeat every 5 minutes IF user was active in Rebel within the last 5 minutes
- Activity is detected via renderer-side DOM events: `keydown`, `pointerdown`, `scroll`
- Only `event.isTrusted` events are counted (filters out synthetic/programmatic events)
- Voice input also counts as activity

**Why not rely on PostHog sessions?**
Background automations (Source Capture, Community Highlights, etc.) fire events that reset PostHog's 30-minute session timer, creating "zombie sessions" that inflate time-based metrics by 2-3x. The heartbeat provides a clean signal of actual user interaction.

**Heartbeat conditions (ALL must be true):**
1. Window is visible (not minimized/hidden)
2. User had trusted input within last 5 minutes (proven by renderer activity ping)
3. Activity occurred after last system suspend/lock

**Note on focus:** We do NOT require window focus at heartbeat time. DOM events in Electron renderers only fire when the user interacts with that specific window. If `lastRendererActivity` was set recently, the user definitely interacted with Rebel - the focus state when the timer fires is irrelevant.

**Files:**
- `src/main/services/userEngagementService.ts` - Main process heartbeat logic
- `src/renderer/hooks/useUserActivityTracking.ts` - Renderer activity detection

### Known Limitations

1. **Single-user per install**: Aliasing permanently merges profiles. If a different user logs into the same device, their events may be attributed to the first user's profile. This is documented as expected behavior.

2. **Events lost on crash**: If the app crashes without graceful shutdown, any queued events in the Node SDK may be lost. This is unavoidable.

3. **Cross-process correlation**: Session IDs must be hashed consistently across main and renderer processes for events to correlate properly in PostHog dashboards.

4. **Engagement heartbeat granularity**: The 5-minute heartbeat interval means engagement is measured in 5-minute buckets. A user who interacts once and leaves may be credited with up to 5 minutes of engagement.




