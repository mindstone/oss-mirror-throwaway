/**
 * Mobile analytics singleton (RudderStack RN) — gated, mobile-local.
 *
 * Mirrors the SHAPE of the desktop renderer analytics singleton
 * (`src/renderer/src/analytics.ts`: init/track/identify/flush/reset/isAvailable)
 * but is entirely mobile-local: it does NOT import or register the shared
 * `@core/tracking` `Tracker` interface (mobile is a consumer of that contract,
 * not a contributor), and it does NOT add to `src/shared/trackingTypes.ts`
 * (mobile event types stay mobile-local).
 *
 * Architecture fact (PLAN Current State): mobile business logic executes on the
 * cloud instance, whose tracker emits core/agent events. Mobile therefore emits
 * ONLY client/UI-origin events from this RN singleton — never re-emits a
 * core/agent-lifecycle event. (Taxonomy + emission land in Stage B3.)
 *
 * ── INERT for Stage B1 ──────────────────────────────────────────────────────
 * This stage ships the API surface, the consent/credential gate, and the
 * privacy-safe redaction path, but DOES NOT INITIALISE the SDK and EMITS
 * NOTHING. `init()` is exported but is not called anywhere yet (no
 * `_layout.tsx` wiring — that is Stage B3). The consent default + privacy
 * declarations land in Stage B2, before any emission is turned on in B3. Every
 * method short-circuits while the SDK is uninitialised, so importing this
 * module is side-effect-free and safe to ship to the auto-deploying mobile
 * preview.
 *
 * Consent model (user decision 2026-06-12): match desktop — always-on,
 * identified by email, disclosed in the privacy policy. No in-app opt-out
 * toggle, no consent persistence, no first-run gate. The only gate beyond
 * "credentials present" is a non-user KILL-SWITCH env flag for incident
 * response. `isAnalyticsPermitted()` = creds present AND kill-switch off.
 */

import rudderClient from '@rudderstack/rudder-sdk-react-native';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { redactAnalyticsProperties } from './redaction';
import { resolveAnonymousId } from './anonymousId';

function resolveWriteKey(): string | undefined {
  const value = process.env.EXPO_PUBLIC_RUDDERSTACK_WRITE_KEY?.trim();
  return value || undefined;
}

function resolveDataPlaneUrl(): string | undefined {
  const value = process.env.EXPO_PUBLIC_RUDDERSTACK_DATA_PLANE_URL?.trim();
  return value || undefined;
}

/**
 * True when the kill-switch env flag is set to an explicit on-value. This is an
 * operational safety lever (incident response), NOT a user-facing consent
 * toggle.
 */
function isKillSwitchOn(): boolean {
  const raw = process.env.EXPO_PUBLIC_DISABLE_ANALYTICS;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * Single chokepoint for the analytics decision — mirrors desktop's
 * `isTelemetryPermitted()`. Checked before `setup()` AND before every
 * `track()`/`identify()`. For the settled consent model this is: credentials
 * present AND the kill-switch off. (No user gate.)
 */
export function isAnalyticsPermitted(): boolean {
  if (isKillSwitchOn()) return false;
  return Boolean(resolveWriteKey() && resolveDataPlaneUrl());
}

let initialized = false;
let enabled = false;
// In-flight (or settled) init promise. Callers that must run AFTER setup
// completes (e.g. identify, which no-ops until `enabled`) await this so they are
// never dropped by a settings fetch resolving before the SDK is ready (GPT F2).
let initPromise: Promise<void> | null = null;

/**
 * Pre-ready event queue (GPT F3).
 *
 * `track()` no-ops until `enabled`, and `init()` is async/fire-and-forget — so
 * cold-start lifecycle events (`App Opened`, the initial `Screen Viewed`) fire
 * BEFORE the SDK finishes setup and would otherwise be silently dropped. While
 * analytics is permitted but not yet enabled (init in flight, or about to be
 * kicked off), we buffer track() calls here and flush them IN ORDER through the
 * SDK once setup succeeds. If init resolves not-permitted or failed, the buffer
 * is dropped (those events were never going to be emitted anyway).
 *
 * Bounded at PRE_READY_QUEUE_CAP to avoid unbounded memory growth if init never
 * completes (e.g. a wedged native bridge). On overflow the OLDEST event is
 * dropped (the freshest cold-start signal is the most valuable). The cap is
 * generous relative to the ~2-3 events realistically emitted before setup
 * settles.
 */
const PRE_READY_QUEUE_CAP = 50;
let preReadyQueue: Array<{ event: string; properties: Record<string, unknown> }> = [];

/** Emit a single event straight through the SDK with the standard redaction + surface tag. */
function emitTracked(event: string, properties: Record<string, unknown>): void {
  // client_surface:'mobile' is injected LAST so a caller's props can never
  // override the surface tag (it is the partition discriminator that keeps
  // mobile events disjoint from the cloud instance's core/agent events).
  // `client_surface` is the cross-surface analytics dimension shared with
  // desktop (`desktop`) and cloud (`cloud`), so all three surfaces group by
  // one clean key.
  const safe = redactAnalyticsProperties({ ...properties, client_surface: 'mobile' });
  void rudderClient.track(event, safe);
}

/** Flush buffered pre-ready events in order, then clear the buffer. */
function flushPreReadyQueue(): void {
  if (preReadyQueue.length === 0) return;
  // Re-check permission AT FLUSH TIME, not only at enqueue: the kill-switch
  // (EXPO_PUBLIC_DISABLE_ANALYTICS) could have flipped on between a track()
  // enqueue and this flush. If analytics is no longer permitted, drop the queued
  // events rather than emitting them (honour the kill-switch over buffered work).
  if (!isAnalyticsPermitted()) {
    dropPreReadyQueue();
    return;
  }
  const pending = preReadyQueue;
  preReadyQueue = [];
  for (const { event, properties } of pending) {
    try {
      emitTracked(event, properties);
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'analytics.mobile.track.flushPreReady',
        reason: 'a single dropped queued analytics event must never crash the app',
        severity: 'warn',
      });
    }
  }
}

/** Drop any buffered pre-ready events (init resolved not-permitted or failed). */
function dropPreReadyQueue(): void {
  preReadyQueue = [];
}

/**
 * Diagnostics view of analytics health (parallels desktop's
 * `getRendererAnalyticsHealth`). Never emits; safe to call any time.
 */
export function getMobileAnalyticsHealth(): {
  initialized: boolean;
  enabled: boolean;
  permitted: boolean;
} {
  return { initialized, enabled, permitted: isAnalyticsPermitted() };
}

async function runInit(): Promise<void> {
    if (initialized) return;

    if (!isAnalyticsPermitted()) {
      initialized = true;
      enabled = false;
      // Not permitted → any buffered pre-ready events will never be emitted.
      dropPreReadyQueue();
      console.info('[analytics:mobile] Disabled', {
        client_surface: 'mobile',
        reason: isKillSwitchOn()
          ? 'kill-switch (EXPO_PUBLIC_DISABLE_ANALYTICS) on'
          : 'missing RudderStack credentials',
      });
      return;
    }

    const writeKey = resolveWriteKey()!;
    const dataPlaneUrl = resolveDataPlaneUrl()!;

    try {
      // Reconcile the anonymousId with the existing install id (rebel_client_id)
      // so analytics identity matches cloud-client's device scoping. Resolve it
      // BEFORE setup() so it can be passed via the setup `options` (the
      // non-deprecated path) rather than the deprecated `setAnonymousId()`
      // method (B1 note). Best-effort: if id resolution fails the SDK falls back
      // to its own generated id, so we still init.
      let anonymousId: string | undefined;
      try {
        anonymousId = await resolveAnonymousId();
      } catch (idError) {
        ignoreBestEffortCleanup(idError, {
          operation: 'analytics.mobile.anonymousIdReconcile',
          reason: 'anonymousId reconcile is best-effort; SDK falls back to its own id',
          severity: 'warn',
        });
      }

      // setup(writeKey, configuration, options) — the third `options` arg is the
      // RudderOption bag, which carries `anonymousId`. Passing it here is the
      // supported, non-deprecated way to seed the anonymousId at init (vs the
      // deprecated `setAnonymousId()` / `putAnonymousId()` post-setup methods).
      await rudderClient.setup(
        writeKey,
        {
          dataPlaneUrl,
          autoCollectAdvertId: false,
          collectDeviceId: false,
          trackAppLifecycleEvents: false,
        },
        anonymousId ? { anonymousId } : null,
      );

      initialized = true;
      enabled = true;
      // SDK is live → flush any events that were buffered during setup (cold-start
      // App Opened / initial Screen Viewed) IN ORDER (GPT F3).
      flushPreReadyQueue();
      console.info('[analytics:mobile] Enabled', { client_surface: 'mobile' });
    } catch (error) {
      // Analytics failure must never block boot or crash the app.
      initialized = true;
      enabled = false;
      // Setup failed → drop the buffer; these events can't be emitted.
      dropPreReadyQueue();
      ignoreBestEffortCleanup(error, {
        operation: 'analytics.mobile.setup',
        reason: 'analytics init failure must never block boot — stay inert',
        severity: 'warn',
      });
    }
}

export const analytics = {
  /**
   * Initialise the RudderStack SDK if permitted. Idempotent and safe to
   * fire-and-forget, but ALSO returns a promise that resolves once setup has
   * settled, so a caller that must run after the SDK is ready (e.g. identify)
   * can `await analytics.init()` to avoid being dropped by the `enabled` gate
   * (GPT F2). SDK config bakes in the privacy-safe defaults:
   *   - `autoCollectAdvertId: false`  — IDFA-free, no `AdSupport.framework`,
   *     no ATT prompt.
   *   - `collectDeviceId: false`      — no device identifier collection.
   *   - `trackAppLifecycleEvents: false` — we hand-emit a curated set in B3
   *     rather than RudderStack's uncurated lifecycle firehose.
   *
   * Wired at APP LAUNCH (not on pairing) gated only on `isAnalyticsPermitted()`
   * — analytics is always-on and emits anonymously from launch; pairing governs
   * IDENTITY only. The in-flight promise is memoised so concurrent callers all
   * await the same setup.
   */
  init: (): Promise<void> => {
    if (initPromise) return initPromise;
    initPromise = runInit();
    return initPromise;
  },

  /**
   * Resolves once init() has settled (whether it enabled the SDK or stayed
   * inert). Returns immediately if init() was never called. Lets identify and
   * other post-setup work serialise behind setup without re-triggering it.
   */
  whenReady: (): Promise<void> => initPromise ?? Promise.resolve(),

  /**
   * Emit a track event (client/UI-origin only).
   *
   * If the SDK is enabled, emits immediately. If analytics is PERMITTED but the
   * SDK isn't ready yet (init in flight / not yet kicked off), the event is
   * BUFFERED in the bounded pre-ready queue and flushed in order once setup
   * succeeds (GPT F3) — this is what keeps cold-start `App Opened` / initial
   * `Screen Viewed` from being silently dropped against the fire-and-forget
   * `init()`. If analytics is NOT permitted (no creds / kill-switch), it's a
   * no-op (and any buffered events are dropped at init).
   */
  track: (event: string, properties: Record<string, unknown> = {}): void => {
    if (!isAnalyticsPermitted()) return;
    if (!enabled) {
      // Permitted but SDK not ready yet. If init already settled to disabled
      // (initialized && !enabled), there's nothing to wait for — drop. Otherwise
      // buffer for flush-on-ready.
      if (initialized) return;
      if (preReadyQueue.length >= PRE_READY_QUEUE_CAP) {
        // Cap reached: drop the OLDEST to keep the freshest cold-start signal.
        preReadyQueue.shift();
      }
      preReadyQueue.push({ event, properties });
      return;
    }
    try {
      emitTracked(event, properties);
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'analytics.mobile.track',
        reason: 'a single dropped analytics event must never crash the app',
        severity: 'warn',
      });
    }
  },

  /** Identify the current user. No-op until initialised + enabled. */
  identify: (userId: string, traits: Record<string, unknown> = {}): void => {
    if (!enabled || !isAnalyticsPermitted() || !userId) return;
    try {
      // Traits may legitimately carry `email` (the SDK-managed identity
      // channel); do NOT route traits through `redactAnalyticsProperties`
      // (which would drop `email`). Identity props belong here, never on
      // track(). The SDK's `identify` overloads are strict (they don't declare
      // the 2-arg `(userId, traits)` form the implementation supports), so cast
      // through a generic call signature at the SDK boundary — mirrors desktop
      // (`src/renderer/src/analytics.ts`).
      const identifyFn = rudderClient.identify.bind(rudderClient) as (
        ...args: unknown[]
      ) => Promise<void>;
      void identifyFn(userId, traits);
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'analytics.mobile.identify',
        reason: 'identify failure must never crash the app; degrade to anonymous',
        severity: 'warn',
      });
    }
  },

  /** Flush the batched event queue (call on AppState background in B3). */
  flush: (): void => {
    if (!enabled || !isAnalyticsPermitted()) return;
    try {
      void rudderClient.flush();
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'analytics.mobile.flush',
        reason: 'flush is best-effort; the SDK retains the batch for the next flush',
        severity: 'warn',
      });
    }
  },

  /**
   * Clear the identified user and (optionally) the anonymousId. Call on unpair
   * (B3) so the IDENTIFIED user never outlives the pairing — analytics REMAINS
   * enabled and keeps emitting anonymously (always-on model). RudderStack
   * `reset(false)` clears the stored userId + traits but PRESERVES the
   * anonymousId, so the shared `rebel_client_id` survives unpair (verified
   * against the RN SDK contract) and we do not need to re-seed it. Keeps the
   * anonymousId by default (reconciled install id is non-PII and stable).
   */
  reset: (clearAnonymousId = false): void => {
    if (!enabled || !isAnalyticsPermitted()) return;
    try {
      void rudderClient.reset(clearAnonymousId);
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'analytics.mobile.reset',
        reason: 'reset failure must never crash the app',
        severity: 'warn',
      });
    }
  },

  /** True once the SDK has initialised and is emitting. */
  isAvailable: (): boolean => enabled,
};

/**
 * TEST-ONLY: reset module state between tests. Not part of the public API.
 * @internal
 */
export function __resetAnalyticsStateForTests(): void {
  initialized = false;
  enabled = false;
  initPromise = null;
  preReadyQueue = [];
}
