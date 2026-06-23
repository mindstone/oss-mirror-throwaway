import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { OAUTH_REFRESH_FAILURE_STORE_VERSION } from '@core/constants';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import type { AuthProviderKey } from '@core/services/diagnostics/manifest';
import { hashAccountSlug } from '@core/services/diagnostics/eventHashing';

/**
 * Liveness contract (passive gate — no self-rearm):
 * - Never schedules its own wake. Persisted `nextRetryAt` is honored only when
 *   `shouldShortCircuit` is called with a fresh `now`.
 * - Sole consumer today: `getGoogleAccessToken` (directCalendarSync.ts:357), invoked by
 *   `calendarSyncScheduler` (calendarSyncScheduler.ts:91-94; 15 min / 30 min on battery).
 * - Any NEW caller of `shouldShortCircuit` must bring its own periodic pump or the
 *   deferred-forever class reopens (260606_recordings_wont_upload_offline_queue).
 */
const log = createScopedLogger({ service: 'oauthRefreshFailureStore' });

const BACKOFF_SCHEDULE_MS = [
  5 * 60 * 1000,      // 5m
  15 * 60 * 1000,     // 15m
  60 * 60 * 1000,     // 1h
  6 * 60 * 60 * 1000, // 6h
  24 * 60 * 60 * 1000, // 24h
] as const;

const JITTER_FRACTION = 0.2;
const MIN_SENTRY_THROTTLE_WINDOW_MS = 5 * 60 * 1000;

const KNOWN_ERROR_CODES = [
  'invalid_grant',
  'unauthorized_client',
  'invalid_client',
  'invalid_request',
  'invalid_scope',
  'unsupported_grant_type',
  'access_denied',
  'unknown',
] as const;

const KNOWN_ERROR_CODE_SET = new Set<string>(KNOWN_ERROR_CODES);

export type OAuthRefreshErrorCode = typeof KNOWN_ERROR_CODES[number];
export type OAuthRefreshShortCircuitReason = 'reauth_required' | 'transient';

export interface OAuthRefreshFailureState {
  consecutiveFailures: number;
  lastErrorCode: OAuthRefreshErrorCode;
  lastFailureAt: number;
  nextRetryAt: number;
  needsReconnect: boolean;
  lastSentryReportAt: number;
}

interface StoredFailureState extends OAuthRefreshFailureState {
  invalidGrantStreak: number;
}

interface OAuthRefreshFailureStoreShape {
  [key: string]: unknown;
  version: number;
  failuresBySlug: Record<string, StoredFailureState>;
}

const OAUTH_REFRESH_FAILURE_STORE_MIGRATIONS: Record<number, (state: OAuthRefreshFailureStoreShape) => OAuthRefreshFailureStoreShape> = {
  // v1 baseline: normalize malformed/corrupted persisted entries.
  1: (state) => ({
    version: OAUTH_REFRESH_FAILURE_STORE_VERSION,
    failuresBySlug: normalizeFailureMap(state.failuresBySlug),
  }),
};

const createDefaultState = (): OAuthRefreshFailureStoreShape => ({
  version: OAUTH_REFRESH_FAILURE_STORE_VERSION,
  failuresBySlug: {},
});

let _store: KeyValueStore<OAuthRefreshFailureStoreShape> | null = null;
const getStore = () => _store ??= createStore<OAuthRefreshFailureStoreShape>({
  name: 'oauth-refresh-failures',
  defaults: createDefaultState(),
});

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const clampNonNegativeInteger = (value: unknown): number => (
  isFiniteNumber(value) ? Math.max(0, Math.floor(value)) : 0
);

function normalizeErrorCode(raw: unknown): OAuthRefreshErrorCode {
  if (typeof raw !== 'string') return 'unknown';
  return KNOWN_ERROR_CODE_SET.has(raw) ? raw as OAuthRefreshErrorCode : 'unknown';
}

function normalizeFailureState(raw: unknown): StoredFailureState | null {
  if (!raw || typeof raw !== 'object') return null;

  const candidate = raw as Partial<StoredFailureState>;
  const consecutiveFailures = clampNonNegativeInteger(candidate.consecutiveFailures);
  const lastErrorCode = normalizeErrorCode(candidate.lastErrorCode);
  const lastFailureAt = clampNonNegativeInteger(candidate.lastFailureAt);
  const nextRetryAt = clampNonNegativeInteger(candidate.nextRetryAt);
  const lastSentryReportAt = clampNonNegativeInteger(candidate.lastSentryReportAt);
  const invalidGrantStreak = clampNonNegativeInteger(candidate.invalidGrantStreak);

  return {
    consecutiveFailures,
    lastErrorCode,
    lastFailureAt,
    nextRetryAt,
    needsReconnect: Boolean(candidate.needsReconnect),
    lastSentryReportAt,
    invalidGrantStreak,
  };
}

function normalizeFailureMap(raw: unknown): Record<string, StoredFailureState> {
  if (!raw || typeof raw !== 'object') return {};
  const map = raw as Record<string, unknown>;
  const normalized: Record<string, StoredFailureState> = {};

  for (const [slug, value] of Object.entries(map)) {
    const trimmedSlug = slug.trim();
    if (!trimmedSlug) continue;
    const state = normalizeFailureState(value);
    if (!state) continue;
    normalized[trimmedSlug] = state;
  }

  return normalized;
}

function normalizeStoreShape(raw: unknown): OAuthRefreshFailureStoreShape {
  if (!raw || typeof raw !== 'object') return createDefaultState();

  const candidate = raw as Partial<OAuthRefreshFailureStoreShape>;
  const version = clampNonNegativeInteger(candidate.version) || OAUTH_REFRESH_FAILURE_STORE_VERSION;
  const failuresBySlug = normalizeFailureMap(candidate.failuresBySlug);

  return { version, failuresBySlug };
}

function migrateStoreShape(state: OAuthRefreshFailureStoreShape): OAuthRefreshFailureStoreShape {
  if (state.version === OAUTH_REFRESH_FAILURE_STORE_VERSION) {
    return state;
  }

  const migration = OAUTH_REFRESH_FAILURE_STORE_MIGRATIONS[OAUTH_REFRESH_FAILURE_STORE_VERSION];
  if (!migration) {
    return createDefaultState();
  }

  return migration(state);
}

function readStoreState(): OAuthRefreshFailureStoreShape {
  try {
    const normalized = normalizeStoreShape(getStore().store);
    if (normalized.version === OAUTH_REFRESH_FAILURE_STORE_VERSION) {
      return normalized;
    }

    const migrated = migrateStoreShape(normalized);
    try {
      getStore().store = migrated;
    } catch (error) {
      log.warn({ err: error }, 'Failed to persist migrated OAuth refresh failure state');
    }
    return migrated;
  } catch (error) {
    log.warn({ err: error }, 'Failed to read OAuth refresh failure state');
    return createDefaultState();
  }
}

/** @returns true when the write persisted, false when it failed (warned, not thrown). */
function writeStoreState(nextState: OAuthRefreshFailureStoreShape): boolean {
  let persisted = false;
  try {
    getStore().store = nextState;
    persisted = true;
  } catch (error) {
    log.warn({ err: error }, 'Failed to persist OAuth refresh failure state');
  }
  return persisted;
}

function getBaseBackoffMs(consecutiveFailures: number): number {
  const index = Math.min(
    Math.max(consecutiveFailures, 1) - 1,
    BACKOFF_SCHEDULE_MS.length - 1,
  );
  return BACKOFF_SCHEDULE_MS[index] ?? BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1];
}

function applyJitter(baseBackoffMs: number): number {
  const random = Math.min(Math.max(Math.random(), 0), 1);
  const factor = (1 - JITTER_FRACTION) + (2 * JITTER_FRACTION * random);
  return Math.round(baseBackoffMs * factor);
}

function getSentryThrottleWindowMs(state: StoredFailureState): number {
  const derivedWindow = state.nextRetryAt - state.lastFailureAt;
  return Math.max(MIN_SENTRY_THROTTLE_WINDOW_MS, derivedWindow);
}

function toPublicState(state: StoredFailureState): OAuthRefreshFailureState {
  return {
    consecutiveFailures: state.consecutiveFailures,
    lastErrorCode: state.lastErrorCode,
    lastFailureAt: state.lastFailureAt,
    nextRetryAt: state.nextRetryAt,
    needsReconnect: state.needsReconnect,
    lastSentryReportAt: state.lastSentryReportAt,
  };
}

function normalizeTimestamp(now: number): number {
  return isFiniteNumber(now) ? Math.floor(now) : Date.now();
}

function normalizeSlug(slug: string): string | null {
  const normalized = slug.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Record a failed OAuth token refresh attempt for one account slug.
 *
 * `opts.provider` is REQUIRED so every emit carries an unambiguous provider
 * label. TypeScript catches missing parameter at compile time — there is no
 * silent emit-skip path.
 */
export function recordFailure(
  slug: string,
  errorCode: string,
  now: number | undefined,
  opts: { provider: AuthProviderKey },
): OAuthRefreshFailureState {
  const normalizedSlug = normalizeSlug(slug);
  const timestamp = normalizeTimestamp(now ?? Date.now());
  const normalizedErrorCode = normalizeErrorCode(errorCode);

  if (!normalizedSlug) {
    log.warn({ errorCode: normalizedErrorCode }, 'Cannot record OAuth refresh failure without account slug');
    return {
      consecutiveFailures: 1,
      lastErrorCode: normalizedErrorCode,
      lastFailureAt: timestamp,
      nextRetryAt: timestamp + applyJitter(getBaseBackoffMs(1)),
      needsReconnect: normalizedErrorCode === 'invalid_grant',
      lastSentryReportAt: 0,
    };
  }

  const storeState = readStoreState();
  const currentState = storeState.failuresBySlug[normalizedSlug];

  const consecutiveFailures = (currentState?.consecutiveFailures ?? 0) + 1;
  const invalidGrantStreak = normalizedErrorCode === 'invalid_grant'
    ? (currentState?.invalidGrantStreak ?? 0) + 1
    : 0;

  const baseBackoffMs = getBaseBackoffMs(consecutiveFailures);
  const nextRetryAt = timestamp + applyJitter(baseBackoffMs);

  const nextState: StoredFailureState = {
    consecutiveFailures,
    lastErrorCode: normalizedErrorCode,
    lastFailureAt: timestamp,
    nextRetryAt,
    needsReconnect: Boolean(currentState?.needsReconnect) || invalidGrantStreak >= 3,
    lastSentryReportAt: currentState?.lastSentryReportAt ?? 0,
    invalidGrantStreak,
  };

  storeState.failuresBySlug[normalizedSlug] = nextState;
  writeStoreState(storeState);

  appendDiagnosticEvent({
    kind: 'auth_event',
    data: {
      transition: 'refresh_failure',
      provider: opts.provider,
      errorCode: normalizedErrorCode,
      needsReconnect: nextState.needsReconnect,
      accountSlugHash: hashAccountSlug(normalizedSlug),
    },
  });

  return toPublicState(nextState);
}

/**
 * Record a successful refresh and clear per-account failure state.
 *
 * Per Stage 1a amendment A5: emit `refresh_success` ONLY when there was prior
 * failure state to clear. `recordSuccess` is also called on every healthy
 * sync to clear stale state — emitting unconditionally would create false-
 * positive auth events for non-refresh successes.
 */
export function recordSuccess(slug: string, opts: { provider: AuthProviderKey }): void {
  const normalizedSlug = normalizeSlug(slug);
  if (!normalizedSlug) return;

  const storeState = readStoreState();
  const existingState = storeState.failuresBySlug[normalizedSlug];
  const hadFailureState = existingState !== undefined && existingState.consecutiveFailures > 0;

  if (existingState) {
    delete storeState.failuresBySlug[normalizedSlug];
    writeStoreState(storeState);
  }

  if (hadFailureState) {
    appendDiagnosticEvent({
      kind: 'auth_event',
      data: {
        transition: 'refresh_success',
        provider: opts.provider,
        needsReconnect: false,
        accountSlugHash: hashAccountSlug(normalizedSlug),
      },
    });
  }
}

/**
 * Explicitly clear tracked failure state for one account (disconnect/re-auth).
 *
 * @returns `true` when nothing was tracked (idempotent no-op) or the entry was
 * cleared and persisted; `false` when the store could not be READ (the entry's
 * existence is unknown — claiming "cleared" would be vacuous) or when the
 * entry exists but the store write was swallowed ([RS-F8] — callers should
 * warn, counts/providers only, so a lingering latch is visible instead of
 * silently surviving the disconnect).
 */
export function clearForSlug(slug: string): boolean {
  const normalizedSlug = normalizeSlug(slug);
  if (!normalizedSlug) return true;

  // Deliberately NOT readStoreState(): it swallows read errors into a
  // default-empty shape, which made a failed read indistinguishable from
  // "nothing tracked" (false success). Mirror listNeedsReconnectProviders'
  // raw-read + normalize instead.
  let rawState: unknown;
  let readFailed = false;
  try {
    rawState = getStore().store;
  } catch (error) {
    log.warn({ err: error }, 'Failed to read OAuth refresh failure state for explicit clear');
    readFailed = true;
  }
  if (readFailed) return false;

  const storeState = migrateStoreShape(normalizeStoreShape(rawState));
  if (!storeState.failuresBySlug[normalizedSlug]) return true;

  delete storeState.failuresBySlug[normalizedSlug];
  return writeStoreState(storeState);
}

/**
 * Synchronously remove every tracked slug that matches `prefix` but is absent
 * from `keepSlugs`. Used by the direct-calendar-sync orphan sweep ([RS-F2]):
 * a needs-reconnect latch whose account has no MCP config entry (the
 * user-actionable universe, [RS-F3]) must not be able to warn indefinitely.
 *
 * Invariants owned here, not at call sites:
 * - Prefix guard: entries of other providers are NEVER touched. Legacy
 *   non-instance slugs (e.g. bare `GoogleWorkspace`) don't match the
 *   instance prefix and are deliberately left alone (cleaned up by the auth
 *   flow's legacy-entry path instead).
 * - Atomicity: zero awaits between read and write — whole-store writes across
 *   awaits would silently clobber concurrent `recordFailure` updates.
 *
 * @returns number of entries actually removed AND persisted (0 when the write
 * was swallowed — the sweep re-runs every sync cycle, so a failed write is
 * retried naturally).
 */
export function removeOrphanedSlugs(prefix: string, keepSlugs: string[]): number {
  if (!prefix) return 0;

  const keep = new Set(keepSlugs);
  const storeState = readStoreState();
  let removed = 0;

  for (const slug of Object.keys(storeState.failuresBySlug)) {
    if (!slug.startsWith(prefix)) continue;
    if (keep.has(slug)) continue;
    delete storeState.failuresBySlug[slug];
    removed += 1;
  }

  if (removed === 0) return 0;
  return writeStoreState(storeState) ? removed : 0;
}

/**
 * Check whether refresh attempts should be short-circuited right now.
 */
export function shouldShortCircuit(
  slug: string,
  now: number,
): { skip: boolean; reason?: OAuthRefreshShortCircuitReason } {
  const state = getStateForSlug(slug);
  if (!state) return { skip: false };

  if (state.needsReconnect) {
    return { skip: true, reason: 'reauth_required' };
  }

  if (normalizeTimestamp(now) < state.nextRetryAt) {
    return { skip: true, reason: 'transient' };
  }

  return { skip: false };
}

/**
 * Return whether this failure should be reported to Sentry now.
 *
 * The report is throttled to once per current backoff window per account slug.
 * Returning `true` updates `lastSentryReportAt` to `now`.
 */
export function shouldReportToSentry(slug: string, now: number): boolean {
  const normalizedSlug = normalizeSlug(slug);
  if (!normalizedSlug) return false;

  const timestamp = normalizeTimestamp(now);
  const storeState = readStoreState();
  const state = storeState.failuresBySlug[normalizedSlug];
  if (!state) return false;

  const throttleWindowMs = getSentryThrottleWindowMs(state);
  if (
    state.lastSentryReportAt > 0 &&
    timestamp - state.lastSentryReportAt < throttleWindowMs
  ) {
    return false;
  }

  storeState.failuresBySlug[normalizedSlug] = {
    ...state,
    lastSentryReportAt: timestamp,
  };
  writeStoreState(storeState);
  return true;
}

export function getStateForSlug(slug: string): OAuthRefreshFailureState | null {
  const normalizedSlug = normalizeSlug(slug);
  if (!normalizedSlug) return null;

  const state = readStoreState().failuresBySlug[normalizedSlug];
  return state ? toPublicState(state) : null;
}

/**
 * Privacy-safe accessor: list distinct providers whose accounts have flipped
 * to `needsReconnect`. Used by the `oauthRefreshHealth` check to populate the
 * HelpMenu glow + connector deep-link toast.
 *
 * Privacy contract — non-negotiable:
 * - The returned `providerBaseName` is ONLY one of: `GoogleWorkspace`,
 *   `Microsoft365Calendar`, `Microsoft365Mail`, or `'unknown'`.
 * - Raw account slug, email address, instance identifier — NONE of these
 *   ever appear in the return value. Account slugs contain emails (e.g.
 *   `GoogleWorkspace-teammember-mindstone-com`); leaking them through this accessor
 *   would expose PII to renderer / Sentry context / diagnostic ledgers.
 * - If the slug prefix doesn't match the closed allowlist, the entry is
 *   coerced to `'unknown'` — never the raw prefix.
 *
 * Read-error path: the underlying `getStore().store` access is wrapped in a
 * try/catch separate from `readStoreState()` so callers can distinguish a
 * true read failure from a legitimate empty state. On throw → `ok: false`;
 * on success → normalize + migrate just like the in-store reader does.
 */
export type NeedsReconnectResult =
  | { ok: true; providers: ReadonlyArray<{ providerBaseName: string }> }
  | { ok: false; reason: 'read-error' };

const PROVIDER_KEY_BY_BASE_NAME: Record<string, AuthProviderKey> = {
  GoogleWorkspace: 'google',
  Microsoft365Calendar: 'microsoft',
  Microsoft365Mail: 'microsoft',
};

/**
 * Log-safe provider label for an account slug: one of the closed allowlist
 * base names or `'unknown'` — NEVER the raw slug/prefix (slugs embed emails;
 * scoped-logger warn/error lines forward to Sentry as breadcrumbs).
 */
export function extractProviderBaseName(slug: string): string {
  const hyphenIdx = slug.indexOf('-');
  const prefix = hyphenIdx > 0 ? slug.slice(0, hyphenIdx) : slug;
  return Object.prototype.hasOwnProperty.call(PROVIDER_KEY_BY_BASE_NAME, prefix)
    ? prefix
    : 'unknown';
}

export function listNeedsReconnectProviders(): NeedsReconnectResult {
  let rawState: unknown;
  try {
    rawState = getStore().store;
  } catch (error) {
    log.warn({ err: error }, 'Failed to read OAuth refresh failure state for needs-reconnect listing');
    return { ok: false, reason: 'read-error' };
  }

  const normalized = normalizeStoreShape(rawState);
  const migrated = migrateStoreShape(normalized);

  const seen = new Set<string>();
  const providers: Array<{ providerBaseName: string }> = [];

  for (const [slug, state] of Object.entries(migrated.failuresBySlug)) {
    if (!state.needsReconnect) continue;
    const providerBaseName = extractProviderBaseName(slug);
    if (seen.has(providerBaseName)) continue;
    seen.add(providerBaseName);
    providers.push({ providerBaseName });
  }

  providers.sort((a, b) => a.providerBaseName.localeCompare(b.providerBaseName));

  return { ok: true, providers };
}

/**
 * MAIN-PROCESS-ONLY accessor for the raw slugs currently latched to
 * `needsReconnect` ([RS-F4]/[GPT-F6]; consumed by the Settings > Connectors
 * per-account overlay).
 *
 * Privacy contract — non-negotiable:
 * - Raw slugs are slugified emails (PII). They must NEVER appear in
 *   health-check details, Sentry-bound fields, or log lines (scoped-logger
 *   warn/error forward to Sentry as breadcrumbs). Counts and provider base
 *   names (`extractProviderBaseName`) are the loggable surface.
 * - The only legitimate use is matching against identifiers that ALREADY
 *   cross to the renderer (MCP config `serverName`s) — never as a new
 *   identifier surface.
 *
 * Read-error path mirrors `listNeedsReconnectProviders`' discriminated result:
 * a true read failure is distinguishable from a legitimately empty store, so
 * consumers can render "unknown" instead of a false all-healthy while
 * `oauthRefreshHealth` warns off the same store.
 *
 * Logging contract (Phase 6 refinement, general reviewer F1): this accessor is
 * QUIET on read failure — the consumer owns the (one-shot) warn. The summary
 * overlay is polled frequently; logging here too produced a double log on the
 * first failure and repeated accessor logs on every later poll.
 */
export type NeedsReconnectSlugsResult =
  | { ok: true; slugs: string[] }
  | { ok: false; reason: 'read-error' };

export function listNeedsReconnectSlugsForMainProcess(): NeedsReconnectSlugsResult {
  let rawState: unknown;
  try {
    rawState = getStore().store;
  } catch {
    // Quiet by contract: the consumer (applyNeedsReconnectOverlay) one-shots
    // the warn for this failure mode. See doc comment above.
    return { ok: false, reason: 'read-error' };
  }

  const normalized = normalizeStoreShape(rawState);
  const migrated = migrateStoreShape(normalized);

  const slugs = Object.entries(migrated.failuresBySlug)
    .filter(([, state]) => state.needsReconnect)
    .map(([slug]) => slug)
    .sort((a, b) => a.localeCompare(b));

  return { ok: true, slugs };
}

export const _testing = {
  getBaseBackoffMs,
  applyJitter,
  getSentryThrottleWindowMs,
};
