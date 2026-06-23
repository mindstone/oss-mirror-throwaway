/**
 * Post-pair identity synchronisation — the race-prone async continuation
 * extracted out of `_layout.tsx` so it is unit-testable (GPT F2).
 *
 * Lifecycle model (PLAN decision log 2026-06-12 23:20): analytics is always-on
 * and initialises at app LAUNCH; PAIRING governs IDENTITY ONLY. On pair we fetch
 * the user's email and feed it to BOTH Sentry's PII-managed user channel AND
 * analytics identify. Two ordering hazards this function closes:
 *
 *   1. identify() no-ops until the SDK is `enabled`, so we MUST await init
 *      (`whenReady`) before identifying — otherwise a settings fetch that
 *      resolves before SDK setup drops the identify.
 *   2. A 401/unpair (or re-pair) can land WHILE we await init + settings. We
 *      capture the pairing generation at entry and re-check it before applying
 *      identity, bailing if it changed so a STALE identity is never applied over
 *      the now-reset/anonymous session.
 *
 * Email is never logged at info level and never placed in analytics track
 * props/tags — it is the identify userId only.
 */

import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

export interface IdentitySyncDeps {
  /** Awaits analytics init (SDK setup) without re-triggering it. */
  whenReady: () => Promise<void>;
  /** Fetch the cloud settings (carries `userEmail`). */
  getSettings: () => Promise<unknown>;
  /**
   * Resolve the stable anonymous install id (`rebel_client_id`) — the SAME id
   * analytics uses as its anonymousId. Used as the Sentry user `id` so Sentry's
   * identity never goes empty even before/without an email, matching desktop and
   * keeping Sentry + analytics identity consistent (GPT F4). Best-effort: may
   * resolve `undefined` if storage cannot provide an id.
   */
  resolveAnonId: () => Promise<string | undefined>;
  /** Current pairing generation (live ref read). */
  currentGeneration: () => number;
  /** Generation captured at the start of THIS paired transition. */
  capturedGeneration: number;
  /**
   * Apply the identified user to Sentry. ALWAYS carries the anon `id`; `email`
   * is added only when the cloud settings provide one (mirrors desktop's
   * `setSentryUser({ id, email? })`).
   */
  setSentryUser: (user: { id?: string; email?: string }) => void;
  /** Identify the user in analytics by email. */
  identifyByEmail: (email: string) => void;
  /** Record an observable breadcrumb (degraded/skipped states). */
  breadcrumb: (category: string, message: string, level: 'info' | 'warning') => void;
}

function extractEmail(settings: unknown): string | undefined {
  if (settings && typeof settings === 'object') {
    const value = (settings as Record<string, unknown>).userEmail;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Serialise behind init, guard against a stale generation, then apply identity.
 * Never throws (degrades to anonymous with an observable breadcrumb).
 */
export async function syncIdentityAfterPair(deps: IdentitySyncDeps): Promise<void> {
  const {
    whenReady,
    getSettings,
    resolveAnonId,
    currentGeneration,
    capturedGeneration,
    setSentryUser,
    identifyByEmail,
    breadcrumb,
  } = deps;

  try {
    // (1) Serialise behind analytics init so identify is not dropped by the
    // `enabled` gate when getSettings() resolves before SDK setup completes.
    await whenReady();
    // Resolve the anon install id alongside settings — it is the Sentry user
    // `id` fallback so Sentry identity matches analytics' anonymousId even when
    // no email is present (GPT F4). Best-effort; resolution failure → undefined.
    const [settings, anonId] = await Promise.all([
      getSettings(),
      resolveAnonId().catch((anonErr) => {
        ignoreBestEffortCleanup(anonErr, {
          operation: 'analytics.mobile.identitySync.resolveAnonId',
          reason: 'anon-id is a best-effort Sentry fallback; degrade to undefined',
          severity: 'debug',
        });
        return undefined;
      }),
    ]);

    // (2) Generation guard: a 401/unpair (or re-pair) landed mid-fetch → bail
    // before applying a stale identity over the reset/anonymous session.
    if (currentGeneration() !== capturedGeneration) {
      breadcrumb(
        'identity',
        'Identify skipped: auth state changed during identity fetch (stale generation)',
        'info',
      );
      return;
    }

    const email = extractEmail(settings);
    const trimmedEmail =
      typeof email === 'string' && email.trim().length > 0 ? email.trim() : undefined;

    // Sentry ALWAYS gets the anon id (matching desktop + analytics' anonymousId),
    // with email added when present. setSentryUser no-ops if neither is set.
    const trimmedAnonId =
      typeof anonId === 'string' && anonId.trim().length > 0 ? anonId.trim() : undefined;
    setSentryUser({
      ...(trimmedAnonId ? { id: trimmedAnonId } : {}),
      ...(trimmedEmail ? { email: trimmedEmail } : {}),
    });

    if (trimmedEmail) {
      // Analytics identify is email-only (the SDK-managed identity channel); the
      // anonymousId is already reconciled to rebel_client_id at init.
      identifyByEmail(trimmedEmail);
    } else {
      breadcrumb(
        'identity',
        'User unidentified after pair: no userEmail in cloud settings (analytics stays anonymous)',
        'warning',
      );
    }
  } catch (err) {
    // getSettings/init failed (offline / transient) — degrade to no-user /
    // anonymous analytics and make the degraded state observable rather than
    // swallowing it (silent-failure rule).
    breadcrumb(
      'identity',
      `Identify skipped: getSettings failed (${err instanceof Error ? err.message : String(err)})`,
      'warning',
    );
    ignoreBestEffortCleanup(err, {
      operation: 'analytics.mobile.identitySync',
      reason:
        'identify is best-effort; degrade to anonymous on transient getSettings/init failure',
      severity: 'warn',
    });
  }
}

/** Sinks for the telemetry-identity CLEAR (unpair). Mirrors the set fan-out. */
export interface ClearIdentityDeps {
  /** Clear the Sentry user (identity). */
  clearSentryContext: () => void;
  /** Reset analytics identity (keeps the anonymousId; analytics stays enabled). */
  resetIdentity: () => void;
}

/**
 * The single telemetry-identity CLEAR chokepoint (DA #1): fan the unpair clear
 * out to BOTH Sentry and analytics from one place, so the set path
 * (`syncIdentityAfterPair`) and the clear path can't drift — a future third
 * telemetry sink is added in exactly one set + one clear function. Synchronous
 * and never throws (each sink is independently best-effort at its own boundary).
 */
export function clearTelemetryIdentity(deps: ClearIdentityDeps): void {
  // Clears the Sentry user (identity) so no orphan identity survives logout.
  deps.clearSentryContext();
  // Analytics REMAINS enabled and keeps emitting ANONYMOUSLY (always-on model);
  // reset() clears the user but preserves the shared rebel_client_id anonymousId.
  deps.resetIdentity();
}
