/**
 * Connector Contribution Store
 *
 * Persists the lifecycle state of OSS MCP connector contributions.
 * Single source of truth for all contribution UI surfaces (MCPBuildCard,
 * PRApprovedBanner, MCPNotificationCard).
 *
 * Uses lazy getStore() pattern following communityEventsStore.ts.
 * Platform-agnostic — no Electron imports.
 *
 * @see docs/plans/260410_oss_mcp_integration_forward_plan.md (P2)
 */

import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { createMigrationRegistry, migrateStore, shouldEnterReadOnlyMode } from '@core/utils/storeMigration';
import { classifyLoadFailure, resolveConfStorePath, safeCreateStore } from '@core/utils/loadStoreSafely';
import { canonicalizeConnectorPath } from '@core/utils/canonicalConnectorPath';
import { isTooManyOpenFilesError } from '@core/utils/emfileRetry';
import { agentTurnRegistry } from './agentTurnRegistry';
import type { AgentEvent } from '@shared/types';
import type {
  ConnectorContribution,
  ContributionStatus,
  ContributionStoreState,
  AcknowledgmentSurface,
  ContributionTurnIndexWindow,
  SoftwareEngineerEvidenceInvalidatedReason,
} from './contributionTypes';
import { VALID_STATE_TRANSITIONS } from './contributionTypes';

const log = createScopedLogger({ service: 'contributionStore' });

/**
 * Builds a human-readable transition error for populating `lastTransitionError`.
 * The message includes the attempted transition, the current status, and the
 * valid next states so both the agent and the UI can self-correct without
 * additional round-trips.
 */
function formatTransitionError(from: ContributionStatus, to: ContributionStatus): string {
  const valid = VALID_STATE_TRANSITIONS[from];
  const validList = valid.length > 0 ? valid.join(', ') : '(terminal state)';
  return `Invalid transition: ${from} → ${to}. Current status is '${from}'; valid next states: ${validList}`;
}

function deriveTurnOrderForWindow(
  eventsByTurn: Record<string, AgentEvent[]>,
): string[] {
  return Object.entries(eventsByTurn)
    .map(([turnId, events], insertionOrder) => {
      const timestamps = events
        .map((event) => event.timestamp)
        .filter((timestamp): timestamp is number => typeof timestamp === 'number');
      const firstTimestamp = timestamps.length > 0
        ? Math.min(...timestamps)
        : Number.POSITIVE_INFINITY;
      return { turnId, insertionOrder, firstTimestamp };
    })
    .sort((a, b) => {
      if (a.firstTimestamp === b.firstTimestamp) {
        return a.insertionOrder - b.insertionOrder;
      }
      return a.firstTimestamp - b.firstTimestamp;
    })
    .map((entry) => entry.turnId);
}

function deriveCurrentSessionTurnIndex(
  sessionId: string,
  fallbackTurn: number,
): number {
  const activeTurnId = agentTurnRegistry.getActiveTurnForSession(sessionId);
  if (!activeTurnId) return fallbackTurn;
  const shape = agentTurnRegistry.getContextAccumulator(activeTurnId);
  if (!shape?.eventsByTurn) return fallbackTurn;
  const order = deriveTurnOrderForWindow(shape.eventsByTurn);
  if (order.length === 0) return fallbackTurn;
  return order.length - 1;
}

function closesBuildWindow(status: ContributionStatus): boolean {
  return status !== 'draft' && status !== 'testing' && status !== 'ready_to_submit';
}

// ─── Version & Migrations ───────────────────────────────────────────

export const CONTRIBUTION_STORE_VERSION = 6;

/**
 * Migration registry for the contribution store.
 *
 * v1 → v2 (260420): additive-only — added `relayContributionId?: string` on
 * `ConnectorContribution`. The field is optional and existing records
 * naturally read `undefined`, so this migration is a no-op beyond the
 * version bump itself. We keep the entry so `storeMigration` can walk the
 * version chain and surface a structured log line for observability (the
 * only way users notice a migration ran is via support-captured logs).
 *
 * @see docs/plans/260420_oss_mcp_backend_relay.md (Stage 2)
 *
 * v2 → v3 (260424): additive-only — added `summary?: string`,
 * `motivation?: string`, and `reviewerNotes?: string` on
 * `ConnectorContribution`. Existing records round-trip unchanged and
 * naturally read the new optional fields as `undefined`.
 *
 * v3 → v4 (260426): backfills `linkedSessionIds` (required, length>=1) from
 * existing `sessionId` + optional `followUpSessionIds`; backfills
 * `canonicalConnectorPath` from `localServerPath` via the platform-aware
 * canonicaliser. Pathless records keep `canonicalConnectorPath: undefined`.
 * Duplicate-path records are PRESERVED (no eager merge per user trade-off);
 * a future Settings affordance handles them. Existing fields including
 * `publishedEmailSentAt` round-trip unchanged.
 *
 * @see docs/plans/260426_foolproof_contribution_flow_stage2.md
 *
 * v4 → v5 (Stage 3.C — 260426): additive no-op. The five new readiness
 * fields (`lastBuildDetectedAt`, `lastTestPassedAt`, `lastRegisteredAt`,
 * `lastReadyRequestedAt`, `lastBuildFingerprint`) start `undefined` for
 * every existing record and are populated lazily as observations fire
 * post-Stage-3 deploy. Per Decision 5 of the Stage 3 plan, no per-record
 * transformation runs — backfilling timestamps would be guess-work, and
 * the safest behaviour is to require fresh observation evidence post-
 * deploy. Existing fields round-trip unchanged.
 *
 * @see docs/plans/260426_foolproof_contribution_flow_stage3.md (§ 3.C, Decision 5)
 *
 * v5 → v6 (Stage 2 SE sensor — 260428): additive no-op. Adds optional
 * `turnIndexWindow`, `lastSoftwareEngineerTaskCompletedAt`,
 * `lastSoftwareEngineerEvidenceInvalidatedAt`, and
 * `lastSoftwareEngineerEvidenceInvalidatedReason` on
 * `ConnectorContribution`. Existing records intentionally remain undefined
 * until observations populate them.
 */
export const CONTRIBUTION_STORE_MIGRATIONS = createMigrationRegistry<ContributionStoreState>({
  1: (data) => {
    // Additive, no-op field. We log here so the one-shot v1 → v2 migration
    // is visible if anyone needs to diagnose a back-compat regression.
    log.info(
      { from: 1, to: 2, contributionCount: (data.contributions ?? []).length },
      'Contribution store migrating v1 → v2 (additive relayContributionId field)',
    );
    return {
      ...data,
      version: 2,
    };
  },
  2: (data) => {
    log.info(
      { from: 2, to: 3, contributionCount: (data.contributions ?? []).length },
      'Contribution store migrating v2 → v3 (additive summary/motivation/reviewerNotes fields)',
    );
    return {
      ...data,
      version: 3,
    };
  },
  3: (data) => {
    log.info(
      { from: 3, to: 4, contributionCount: (data.contributions ?? []).length },
      'Contribution store migrating v3 → v4 (additive canonicalConnectorPath + linkedSessionIds)',
    );
    return {
      ...data,
      version: 4,
      contributions: (data.contributions ?? []).map((c) => {
        const followUps = c.followUpSessionIds ?? [];
        // First-seen order: originating sessionId at [0], followUps appended.
        // Dedupe defensively in case followUpSessionIds happens to contain
        // sessionId or duplicates from older buggy paths.
        const linkedSessionIds: string[] = [];
        for (const sid of [c.sessionId, ...followUps]) {
          if (!linkedSessionIds.includes(sid)) linkedSessionIds.push(sid);
        }
        const canonical = c.localServerPath
          ? canonicalizeConnectorPath(c.localServerPath)
          : '';
        const next: ConnectorContribution = {
          ...c,
          linkedSessionIds,
        };
        if (canonical) {
          next.canonicalConnectorPath = canonical;
        }
        // Per user trade-off: NO eager dedupe of duplicate-path records.
        // The Settings-level affordance (out of scope for Stage 2) handles
        // them. The path-uniqueness invariant is enforced at ingress sites
        // (Stage 2.D), not at the store CRUD layer.
        return next;
      }),
    };
  },
  4: (data) => {
    // Stage 3.C (260426): additive no-op. The five new readiness fields
    // (`lastBuildDetectedAt`, `lastTestPassedAt`, `lastRegisteredAt`,
    // `lastReadyRequestedAt`, `lastBuildFingerprint`) start `undefined`
    // and are populated lazily by the `contributionObservationService`
    // reducer as observations fire post-deploy. Per Decision 5 of the
    // Stage 3 plan, backfilling timestamps would be guess-work; the
    // safest behaviour is to require fresh observation evidence post-
    // deploy. Existing fields round-trip unchanged.
    log.info(
      { from: 4, to: 5, contributionCount: (data.contributions ?? []).length },
      'Contribution store migrating v4 → v5 (additive readiness timestamps + lastBuildFingerprint)',
    );
    return {
      ...data,
      version: 5,
    };
  },
  5: (data) => {
    log.info(
      { from: 5, to: 6, contributionCount: (data.contributions ?? []).length },
      'Contribution store migrating v5 → v6 (additive SE sensor fields)',
    );
    return {
      ...data,
      version: 6,
    };
  },
});

// ─── Default State ──────────────────────────────────────────────────

export function createDefaultState(): ContributionStoreState {
  return {
    version: CONTRIBUTION_STORE_VERSION,
    contributions: [],
  };
}

// ─── Lazy Store ─────────────────────────────────────────────────────

let _store: KeyValueStore<ContributionStoreState> | null = null;
let _storeInitialized = false;

// ============================================================================
// In-memory cache (EMFILE mitigation — REBEL-1HF)
// ============================================================================
//
// `useMcpBuildCardState` polls the contribution store every 2s via
// `contribution:get-by-session` and `useContributionNotifications` polls
// every 3s via `contribution:list`. The underlying `electron-store`/`conf`
// `.get()`/`.store` accessors call `fs.readFileSync()` on every access, so
// uncached polling directly amplifies Windows file-descriptor exhaustion
// (EMFILE / ENFILE — see REBEL-1HF investigation).
//
// We cache the entire `ContributionStoreState` in memory after the first
// successful read and serve subsequent reads from the cache. Writes update
// the cache only after the underlying disk write succeeds, so an EMFILE
// write doesn't lock in a stale cache.
//
// On EMFILE/ENFILE read failure we must NOT reset-write the store — that
// would turn a read-side FD-exhaustion error into a write-side one against
// `connector-contributions.json.tmp-*`. We return cached data when
// available, otherwise an ephemeral default (deliberately NOT cached so
// recovery can hydrate from disk once EMFILE clears).
//
// Mirrors the proven `toolUsageStore` (REBEL-1C8) and `settingsStore`
// patterns. See `src/core/services/toolUsageStore.ts` for the canonical
// pattern.
let _cachedState: ContributionStoreState | null = null;
let _awaitingHydratedLoadAfterFdExhaustion = false;
/**
 * Read-only mode for the contribution store. Set when:
 *  - the migration result is a future_version OR a corrupted migration (in both
 *    cases the on-disk file holds real data we did NOT migrate/overwrite —
 *    `shouldPersist: false`), OR
 *  - the generic (non-EMFILE) load-error catch classified the on-disk file as
 *    EXISTING-but-unreadable (corrupt JSON / schema / decrypt / transient IO).
 *
 * In every case the real, intact-but-momentarily-unreadable file is preserved on
 * disk, so every write must be blocked — otherwise the first CRUD op would
 * `store.set(...)` the in-memory defaults over the user's real contributions
 * (the data-reset class). Like the rest of the F1 guard this latch is
 * read-only-until-restart: there is no same-session auto-recovery.
 */
let _contributionReadOnlyMode = false;

/**
 * Test-only helper: clear the in-memory contribution cache.
 * Intended for tests that need a fresh load between cases.
 * @internal
 */
export function __resetContributionCacheForTests(): void {
  _cachedState = null;
  _awaitingHydratedLoadAfterFdExhaustion = false;
  _contributionReadOnlyMode = false;
}

/**
 * REBEL-1HF: returns `true` when the store is currently in the post-EMFILE
 * "awaiting hydration" state — i.e., a prior init or read hit
 * `EMFILE`/`ENFILE` and the cache has not yet been re-primed from disk.
 *
 * IPC handlers surface this through the response envelope (as
 * `fdExhausted`) so renderer pollers can ratchet up their backoff even
 * though the handler itself returns success-shaped (cached/empty) data.
 * Without this signal the renderer's `isEmfileError(err)` check is dead
 * code — the IPC layer never throws on EMFILE; it returns degraded data.
 */
export function isContributionStoreFdExhausted(): boolean {
  return _awaitingHydratedLoadAfterFdExhaustion;
}

function getStore(): KeyValueStore<ContributionStoreState> {
  if (!_store) {
    // Guard CONSTRUCTION: conf reads+validates its backing file eagerly, so a
    // corrupt `connector-contributions.json` throws at construct time (before the
    // init try/catch below can run). `safeCreateStore` preserves+backs up the raw
    // file, latches an ephemeral read-only store, and never crashes init.
    const created = safeCreateStore<ContributionStoreState>(
      { name: 'connector-contributions', defaults: createDefaultState() },
      createDefaultState(),
    );
    _store = created.store;
    if (created.loadFailed) {
      _contributionReadOnlyMode = true;
      _storeInitialized = true; // construction itself failed; skip the migrate walk.
      _cachedState = createDefaultState();
    }
  }
  if (!_storeInitialized) {
    _storeInitialized = true;
    try {
      const stored = _store.store;

      const migrationResult = migrateStore<ContributionStoreState>(stored, {
        storeName: 'connector-contributions',
        currentVersion: CONTRIBUTION_STORE_VERSION,
        migrations: CONTRIBUTION_STORE_MIGRATIONS,
        createDefault: createDefaultState,
      });

      // Read-only on future_version AND corrupted: in both cases the on-disk
      // data was NOT overwritten (`shouldPersist: false`), so block writes that
      // would clobber it with in-memory defaults.
      _contributionReadOnlyMode = shouldEnterReadOnlyMode(migrationResult);

      if (migrationResult.shouldPersist && migrationResult.status !== 'future_version') {
        try {
          _store.store = migrationResult.data as ContributionStoreState;
          log.info(
            { status: migrationResult.status, fromVersion: migrationResult.fromVersion, toVersion: migrationResult.toVersion },
            'Contribution store initialized',
          );
        } catch (persistError) {
          // EMFILE during migration persist: keep the in-memory state and
          // continue. The cache will hold the migrated data so subsequent
          // reads serve correct results; the next successful write
          // reconciles the on-disk file.
          log.warn(
            { err: persistError },
            'Failed to persist migrated contribution store - continuing with in-memory state',
          );
        }
      }

      // Start from the migrated data — this becomes the basis for the
      // in-memory cache. Backfill may further mutate the on-disk store and
      // produce a refined cache shape; we capture both paths below.
      // Defensive coerce: the underlying store may return a partial shape
      // (no `contributions` array yet on a fresh install, or a malformed
      // record from a future-version sentinel); we backfill to a valid
      // shape rather than letting downstream `[...existing]` spreads fail.
      const migrated = migrationResult.data as Partial<ContributionStoreState> | undefined;
      let postInitState: ContributionStoreState = {
        version: migrated?.version ?? CONTRIBUTION_STORE_VERSION,
        contributions: Array.isArray(migrated?.contributions)
          ? migrated.contributions
          : [],
      };

      if (_contributionReadOnlyMode) {
        log.warn(
          {
            dataVersion: stored.version,
            currentVersion: CONTRIBUTION_STORE_VERSION,
            migrationStatus: migrationResult.status,
          },
          'Contribution store read-only (future_version or corrupted migration) — skipping back-fill and blocking writes to preserve on-disk data',
        );
      } else {
        // One-time `publishedEmailSentAt` back-fill for records that reached
        // `published` before this field existed. Without it, Stage 3's refresh
        // hook (`status === 'published' && !publishedEmailSentAt`) would fire a
        // retroactive "your connector is live" email on the first post-deploy
        // refresh for every pre-existing published contribution. The server
        // would have no prior email_log row and would actually send — a
        // user-trust regression. We intentionally write directly to the
        // contributions array (not via `updateContribution`) because these
        // records are already at the terminal `published` state and we are
        // only stamping an absent metadata field — not transitioning status.
        try {
          const backfilled = backfillPublishedEmailSentAt(_store);
          log.info(
            { backfilled },
            'Contribution store published-email back-fill complete',
          );
          if (backfilled > 0) {
            // Backfill mutated the on-disk store; capture the post-backfill
            // contributions for the cache so we don't serve stale data
            // (`migrationResult.data` predates the backfill rewrite).
            try {
              postInitState = {
                ...postInitState,
                contributions: _store.get('contributions') ?? postInitState.contributions,
              };
            } catch (postReadError) {
              // EMFILE on the post-backfill read: fall back to the pre-backfill
              // shape — slightly stale but consistent. A subsequent successful
              // load will re-prime via the disk read.
              log.warn(
                { err: postReadError },
                'Failed to re-read contributions after back-fill - using pre-back-fill cache snapshot',
              );
            }
          }
        } catch (backfillError) {
          // Back-fill is best-effort; never block initialization.
          log.warn(
            { err: backfillError },
            'Contribution store published-email back-fill failed - continuing without back-fill',
          );
        }
      }

      // Prime the cache so subsequent reads stay off the disk.
      _cachedState = postInitState;
      _awaitingHydratedLoadAfterFdExhaustion = false;
    } catch (initError) {
      // First-load FD exhaustion: do NOT reset-write. Leave the cache empty
      // so the next call can retry the disk read once descriptors recover.
      // The hydration guard prevents writes from racing in with a synthetic
      // default that would clobber on-disk history.
      if (isTooManyOpenFilesError(initError)) {
        log.warn(
          { err: initError },
          'Contribution store initialization hit file-descriptor exhaustion - serving ephemeral default until recovery',
        );
        // Mark uninitialized so the next call retries the migration walk.
        _storeInitialized = false;
        _cachedState = null;
        _awaitingHydratedLoadAfterFdExhaustion = true;
      } else {
        // Generic (non-EMFILE) load error — corrupt JSON / schema / decrypt /
        // transient IO. The PRE-FIX behaviour primed the cache with defaults and
        // "let downstream writes self-heal the on-disk file" — but that means the
        // first `updateContribution`/`saveContributions` persists empty defaults
        // OVER a real-but-corrupt `connector-contributions.json` (the F1 wipe
        // class). Instead: classify ENOENT-vs-existing via the shared guard. If
        // the file EXISTS (load-failed), preserve+back up the raw bytes, latch
        // read-only so all writes are blocked, and run on ephemeral in-memory
        // defaults this session. If genuinely ABSENT, a fresh writable default is
        // fine (legitimate first run).
        const classified = classifyLoadFailure(
          'connector-contributions',
          resolveConfStorePath('connector-contributions'),
          initError,
        );
        if (classified.outcome === 'load-failed') {
          _contributionReadOnlyMode = true;
          log.warn(
            { err: initError, backupPath: classified.backupPath },
            'Contribution store load failed on existing data - preserving on-disk file, running on ephemeral in-memory defaults (read-only this session)',
          );
        } else {
          log.warn(
            { err: initError },
            'Contribution store initialization failed on absent file - serving fresh in-memory default (writable)',
          );
        }
        _cachedState = createDefaultState();
        _awaitingHydratedLoadAfterFdExhaustion = false;
      }
    }
  }
  return _store;
}

/**
 * Read-only check that GUARANTEES the store has run its one-time init first.
 *
 * `_contributionReadOnlyMode` defaults to `false` and is only set during
 * `getStore()`'s init (future_version / corrupted migration / existing-but-
 * unreadable load failure). A writer that checked the bare flag as the FIRST
 * touch (no prior read) would see a stale `false` and bypass the guard — wiping
 * a real on-disk store. Calling `getStore()` here forces init (which sets the
 * flag) before we read it, making every write guard first-touch-safe by
 * construction. Mirrors `isAchievementsReadOnly()` / `isInboxReadOnly()`.
 */
function isContributionStoreReadOnly(): boolean {
  getStore();
  return _contributionReadOnlyMode;
}

/**
 * Read the contribution list, preferring the in-memory cache.
 *
 * - Cache hit: returns the cached `contributions` array directly (no disk I/O).
 * - Cache miss: invokes `getStore()` which hydrates the cache via the
 *   migration walk; returns the fresh array.
 * - EMFILE/ENFILE during hydration: returns an empty default array WITHOUT
 *   caching it, so the next call retries the disk read once descriptors
 *   recover. NEVER triggers a reset-write.
 *
 * All store reads in this module funnel through this helper.
 */
function loadContributions(): ConnectorContribution[] {
  // Snapshot to a local — closures and re-assignment paths inside this
  // function defeat TS's flow narrowing on the module-level variable.
  const cachedHit = _cachedState;
  if (cachedHit !== null) {
    return cachedHit.contributions ?? [];
  }

  try {
    // `getStore()` initializes and primes `_cachedState` on success.
    const store = getStore();
    const cachedAfterInit = _cachedState as ContributionStoreState | null;
    if (cachedAfterInit !== null) {
      return cachedAfterInit.contributions ?? [];
    }
    // Defensive: if `getStore()` couldn't prime the cache (e.g. EMFILE during
    // first init), fall through to direct read. This will EMFILE again and
    // we'll handle it identically.
    const contributions = store.get('contributions') ?? [];
    return contributions;
  } catch (error) {
    const cachedDuringFailure = _cachedState as ContributionStoreState | null;
    if (isTooManyOpenFilesError(error)) {
      log.warn(
        { err: error, hasCachedState: cachedDuringFailure !== null },
        'Contribution store read failed due to file-descriptor exhaustion - serving in-memory state without reset-writing',
      );
      if (cachedDuringFailure !== null) {
        return cachedDuringFailure.contributions ?? [];
      }
      // Deliberately do not cache this ephemeral default: let the next call
      // retry the disk read once the process recovers file descriptors.
      _awaitingHydratedLoadAfterFdExhaustion = true;
      return [];
    }
    log.warn(
      { err: error },
      'Contribution store read failed with non-FD error - serving in-memory default',
    );
    return cachedDuringFailure?.contributions ?? [];
  }
}

/**
 * Write the contribution list through to disk and mirror into the in-memory
 * cache on success. If the disk write throws (e.g. EMFILE), the cache is
 * intentionally left untouched so the next successful load rehydrates from
 * disk rather than locking in a possibly-stale or synthetic in-memory state.
 *
 * Errors propagate to callers — IPC handlers already catch and degrade
 * gracefully (return defaults / `success: false`). The error is also
 * propagated to the renderer transport in cases where the handler chooses
 * to re-throw.
 *
 * REBEL-1HF: refuses to write while the store is still in its post-EMFILE
 * "awaiting hydration" state. Without this guard a write could persist a
 * synthetic empty/default state to disk during FD exhaustion and clobber
 * real data once descriptors recover. The error propagates to the IPC
 * handler's catch block so write channels surface `success: false`.
 */
function saveContributions(next: ConnectorContribution[]): void {
  if (isContributionStoreReadOnly()) {
    // The store is running on in-memory defaults after a future_version /
    // corrupted migration, OR an existing-but-unreadable load failure; the real
    // data is intact on disk. Persisting here would overwrite it with
    // defaults-derived state. Block the write.
    log.warn(
      'Refusing contribution write - store is in read-only mode (future_version, corrupted migration, or load failure); on-disk data preserved',
    );
    throw new Error(
      'Contribution store is read-only (future_version, corrupted migration, or load failure) — refusing write to preserve on-disk data',
    );
  }
  if (_awaitingHydratedLoadAfterFdExhaustion) {
    log.warn(
      'Refusing contribution write before post-EMFILE hydration — cache has not been primed from disk yet',
    );
    throw new Error(
      'Contribution store has not hydrated from disk after FD exhaustion — refusing write to prevent data loss',
    );
  }
  const store = getStore();
  store.set('contributions', next);
  // Mirror to cache only after the write succeeded. On EMFILE the set()
  // throws and we never reach this line, leaving the cache untouched.
  if (_cachedState !== null) {
    _cachedState = { ...(_cachedState), contributions: next };
  } else {
    _cachedState = { version: CONTRIBUTION_STORE_VERSION, contributions: next };
  }
  _awaitingHydratedLoadAfterFdExhaustion = false;
}

/**
 * Stamps `publishedEmailSentAt = updatedAt` for any record already at
 * `status: 'published'` that lacks the field. Idempotent: records that
 * already have the field are left alone; non-`published` records are never
 * touched. Returns the number of records stamped (0 is common and expected
 * on fresh installs or after the first run).
 */
function backfillPublishedEmailSentAt(
  store: KeyValueStore<ContributionStoreState>,
): number {
  const contributions = store.get('contributions') ?? [];
  let count = 0;
  const next = contributions.map((c) => {
    if (c.status === 'published' && !c.publishedEmailSentAt) {
      count++;
      return { ...c, publishedEmailSentAt: c.updatedAt };
    }
    return c;
  });
  if (count > 0) {
    store.set('contributions', next);
  }
  return count;
}

// ─── ID Generation ──────────────────────────────────────────────────

function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `contrib-${timestamp}-${random}`;
}

// ─── State Transition Validation ────────────────────────────────────

function isValidTransition(from: ContributionStatus, to: ContributionStatus): boolean {
  const validTargets = VALID_STATE_TRANSITIONS[from];
  return validTargets.includes(to);
}

// ─── CRUD Operations ────────────────────────────────────────────────

/**
 * Create a new contribution record.
 * Generates a unique ID and timestamps.
 */
export function createContribution(
  input: Omit<
    ConnectorContribution,
    | 'id'
    | 'createdAt'
    | 'updatedAt'
    | 'acknowledgedEvents'
    // Stage 2 (260426): the store derives both fields from the supplied
    // `sessionId` / `localServerPath`. Allowing callers to override would
    // invite test-only divergence from production semantics.
    | 'linkedSessionIds'
    | 'canonicalConnectorPath'
    // Stage 3.C (260426): the four readiness timestamps are written by
    // the observation reducer (`contributionObservationService`) only —
    // creation never carries them. `lastBuildFingerprint` is the lone
    // exception (admitted below) because the observation service
    // computes it BEFORE `createContribution` so we can stamp the
    // brand-new record with it atomically. Filtering the timestamps out
    // here prevents drift between create-time defaults and the
    // observation pipeline.
    | 'lastBuildDetectedAt'
    | 'lastTestPassedAt'
    | 'lastRegisteredAt'
    | 'lastReadyRequestedAt'
    // Stage 2 (260428): SE sensor-only derived fields are observation-
    // reducer owned. Creation should never stamp them directly.
    | 'turnIndexWindow'
    | 'lastSoftwareEngineerTaskCompletedAt'
    | 'lastSoftwareEngineerEvidenceInvalidatedAt'
    | 'lastSoftwareEngineerEvidenceInvalidatedReason'
  > & {
    acknowledgedEvents?: ConnectorContribution['acknowledgedEvents'];
    /**
     * Stage 3.C (260426): optional pre-computed SHA-256 fingerprint of the
     * connector's `package.json` mtime|size. The observation service
     * (Stage 3.D) computes the fingerprint BEFORE calling
     * `createContribution` because `src/core/` may not import `node:fs`
     * directly. Leaving this undefined is a no-op until the first build
     * observation fires it.
     */
    lastBuildFingerprint?: string;
  },
): ConnectorContribution {
  const now = new Date().toISOString();
  // Stage 2.C (260426): derive `linkedSessionIds` (length>=1, originator at
  // [0]) and `canonicalConnectorPath` from `localServerPath` so every
  // newly-created record carries the path-keyed identity invariant.
  const canonical = input.localServerPath
    ? canonicalizeConnectorPath(input.localServerPath)
    : '';
  const contribution: ConnectorContribution = {
    id: generateId(),
    sessionId: input.sessionId,
    linkedSessionIds: [input.sessionId],
    connectorName: input.connectorName,
    status: input.status,
    attributionMode: input.attributionMode,
    acknowledgedEvents: input.acknowledgedEvents ?? [],
    createdAt: now,
    updatedAt: now,
    ...(input.followUpSessionIds !== undefined && { followUpSessionIds: input.followUpSessionIds }),
    ...(input.localServerPath !== undefined && { localServerPath: input.localServerPath }),
    ...(canonical && { canonicalConnectorPath: canonical }),
    ...(input.catalogEntryId !== undefined && { catalogEntryId: input.catalogEntryId }),
    ...(input.attributionName !== undefined && { attributionName: input.attributionName }),
    ...(input.summary !== undefined && { summary: input.summary }),
    ...(input.motivation !== undefined && { motivation: input.motivation }),
    ...(input.reviewerNotes !== undefined && { reviewerNotes: input.reviewerNotes }),
    ...(input.prTitle !== undefined && { prTitle: input.prTitle }),
    ...(input.prBody !== undefined && { prBody: input.prBody }),
    ...(input.prUrl !== undefined && { prUrl: input.prUrl }),
    ...(input.workflowRunUrl !== undefined && { workflowRunUrl: input.workflowRunUrl }),
    ...(input.reviewNotes !== undefined && { reviewNotes: input.reviewNotes }),
    ...(input.publishedCatalogId !== undefined && { publishedCatalogId: input.publishedCatalogId }),
    ...(input.lastCheckedAt !== undefined && { lastCheckedAt: input.lastCheckedAt }),
    ...(input.lastBuildFingerprint !== undefined && { lastBuildFingerprint: input.lastBuildFingerprint }),
  };

  const existing = loadContributions();
  saveContributions([...existing, contribution]);

  log.info({ contributionId: contribution.id, connectorName: contribution.connectorName }, 'Created contribution');
  return contribution;
}

/**
 * Get a contribution by its ID.
 * Returns undefined if not found.
 */
export function getContributionById(id: string): ConnectorContribution | undefined {
  const contributions = loadContributions();
  return contributions.find((c) => c.id === id);
}

/**
 * Compat shim. Calls `getActiveContributionBySession` and emits a one-time
 * `log.warn` (per session+chosen+active key) when the legacy first-match
 * lookup would have returned a different record. Used to measure cutover
 * impact ahead of Stage 3's deletion of the shim.
 *
 * @deprecated since Stage 2 (260426); use `getActiveContributionBySession`
 *   or `getContributionsBySession`. Stage 3 deletes this in favour of
 *   explicit path-keyed lookups.
 */
export function getContributionBySession(sessionId: string): ConnectorContribution | undefined {
  const contributions = loadContributions();
  // Legacy first-match (the historical semantics — preserved as the return
  // value so direct callers aren't surprised mid-cutover).
  const legacyFirstMatch = contributions.find((c) => c.sessionId === sessionId);
  // New "active" semantics: walk linkedSessionIds and pick max(updatedAt).
  const active = pickActiveBySession(contributions, sessionId);
  // Warn (suppressed per (session, chosen, active) triple) when the two
  // lookups would diverge, so we can measure cutover impact.
  maybeWarnCompatShimDivergence(sessionId, legacyFirstMatch, active);
  return legacyFirstMatch;
}

/**
 * Get the most-recently-updated contribution where `linkedSessionIds`
 * includes `sessionId`. Returns `undefined` when no record matches.
 *
 * Replaces the legacy first-match semantics of `getContributionBySession`
 * everywhere except the explicit compat shim. Stage 2.D (260426) migrates
 * ingress sites to call this directly.
 *
 * Tie-break on equal `updatedAt`: oldest `createdAt` wins (older record is
 * "more authoritative"; new records are more likely to be experimental).
 */
export function getActiveContributionBySession(
  sessionId: string,
): ConnectorContribution | undefined {
  const contributions = loadContributions();
  return pickActiveBySession(contributions, sessionId);
}

/**
 * All contributions where `linkedSessionIds.includes(sessionId)`. Returned
 * in `updatedAt` ascending order (oldest first) so callers iterating for
 * presentation get a stable, intuitive sequence.
 */
export function getContributionsBySession(sessionId: string): ConnectorContribution[] {
  const contributions = loadContributions();
  const matches = contributions.filter((c) =>
    matchesLinkedSession(c, sessionId),
  );
  // Sort by updatedAt ascending; tie-break on createdAt ascending for stable
  // ordering across runs.
  return matches.slice().sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return 0;
  });
}

/**
 * Get the contribution record for a given canonical path. Returns the
 * most-recently-updated record when multiple legacy records share the path
 * (collision policy per Stage 2 plan; see Decision 5).
 *
 * Pass paths through `canonicalizeConnectorPath()` BEFORE calling this.
 * Empty / undefined input returns `undefined` immediately (the pathless-
 * record sentinel).
 *
 * Tie-break on equal `updatedAt`: oldest `createdAt` wins.
 */
export function getContributionByPath(
  canonicalPath: string,
): ConnectorContribution | undefined {
  // Empty input is the pathless-record sentinel — short-circuit before
  // touching the store. Pathless records have `canonicalConnectorPath:
  // undefined` (NOT '') so a non-short-circuited scan would miss them
  // anyway, but skipping it avoids the wasted O(records) traversal.
  if (!canonicalPath) return undefined;
  const contributions = loadContributions();
  const matches = contributions.filter(
    (c) => c.canonicalConnectorPath === canonicalPath,
  );
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  return matches.reduce((winner, candidate) => {
    if (candidate.updatedAt !== winner.updatedAt) {
      return candidate.updatedAt > winner.updatedAt ? candidate : winner;
    }
    // Tie-break: older createdAt wins.
    return candidate.createdAt < winner.createdAt ? candidate : winner;
  });
}

// ─── Lookup helpers (private) ──────────────────────────────────────

function matchesLinkedSession(
  c: ConnectorContribution,
  sessionId: string,
): boolean {
  return (c.linkedSessionIds ?? []).includes(sessionId);
}

function pickActiveBySession(
  contributions: ConnectorContribution[],
  sessionId: string,
): ConnectorContribution | undefined {
  const matches = contributions.filter((c) => matchesLinkedSession(c, sessionId));
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  return matches.reduce((winner, candidate) => {
    if (candidate.updatedAt !== winner.updatedAt) {
      return candidate.updatedAt > winner.updatedAt ? candidate : winner;
    }
    return candidate.createdAt < winner.createdAt ? candidate : winner;
  });
}

// ─── Compat shim warn (Stage 2.C, 260426) ──────────────────────────

/**
 * Suppression set for the compat-shim divergence warn. Keys are
 * `${sessionId}|${chosenId}|${activeId}` triples; cardinality is bounded by
 * the number of distinct cross-session followup conflicts in the user's
 * lifetime (single-digits in any realistic scenario).
 */
const compatShimWarnedKeys = new Set<string>();

function maybeWarnCompatShimDivergence(
  sessionId: string,
  chosen: ConnectorContribution | undefined,
  active: ConnectorContribution | undefined,
): void {
  if (!chosen || !active) return;
  if (chosen.id === active.id) return;
  const key = `${sessionId}|${chosen.id}|${active.id}`;
  if (compatShimWarnedKeys.has(key)) return;
  compatShimWarnedKeys.add(key);
  log.warn(
    {
      sessionId,
      legacyFirstMatchId: chosen.id,
      activeRecordId: active.id,
      legacyFirstMatchStatus: chosen.status,
      activeRecordStatus: active.status,
      breadcrumb: 'contributionStore.compat-shim-divergence',
    },
    'getContributionBySession compat shim returned a different record than legacy first-match would have. ' +
      'Stage 3 will remove this shim; track this log to verify cutover safety.',
  );
}

/** Test-only: clear the compat-shim suppression set. */
export function _resetCompatShimWarnedKeysForTesting(): void {
  compatShimWarnedKeys.clear();
}

/**
 * Update a contribution by ID.
 *
 * If the update includes a `status` change, validates the transition
 * against VALID_STATE_TRANSITIONS. Returns `null` for invalid transitions,
 * `undefined` if the contribution is not found.
 *
 * Stage 3 (260426) callsite invariant: status transitions to
 * `ready_to_submit` MUST flow through `observeContribution()` in
 * `contributionObservationService.ts`. Direct callers writing
 * `status: 'ready_to_submit'` here bypass the reducer's evidence
 * gate and re-introduce matrix #22 (direct-create self-verifies).
 * Side-data updates (connectorName, prTitle, prBody, summary, etc.)
 * remain free to use this surface directly.
 */
export function updateContribution(
  id: string,
  updates: Omit<
    Partial<Omit<ConnectorContribution, 'id' | 'createdAt' | 'acknowledgedEvents'>>,
    'attributionName' | 'relayContributionId'
  > & {
    /**
     * Stage 1.1 (260420 relay): pass `null` to explicitly clear a previously-
     * stored attribution name. `undefined` leaves the existing value alone.
     */
    attributionName?: string | null;
    /**
     * Stage 3 (260427 follow-on submission auth): pass `null` to explicitly
     * clear a previously-stored relay contribution id. `undefined` leaves the
     * existing value alone.
     */
    relayContributionId?: string | null;
  },
): ConnectorContribution | undefined | null {
  const contributions = loadContributions();
  const index = contributions.findIndex((c) => c.id === id);

  if (index === -1) {
    return undefined;
  }

  const current = contributions[index];

  // Stage 2 / Opus Finding 5: Same-status short-circuit. If the update's status
  // matches the current status AND no other fields are being changed, return
  // the existing record unchanged. This prevents silent double-promotion
  // (two concurrent `ready_to_submit` calls where the second would otherwise
  // overwrite `updatedAt` / telemetry side-data) and clarifies the invariant
  // that state transitions are the ONLY reason to re-write the record's status.
  //
  // If the caller passes status === current.status alongside OTHER updates
  // (e.g. `{ status: 'testing', prUrl: 'https://…' }`), we still apply the
  // non-status updates but skip the transition-log line. This preserves
  // existing side-data update flows.
  const isSameStatusNoOp =
    updates.status !== undefined &&
    updates.status === current.status &&
    Object.keys(updates).every((key) => key === 'status' || updates[key as keyof typeof updates] === current[key as keyof typeof current]);

  if (isSameStatusNoOp) {
    return current;
  }

  // Validate state transition if status is being changed
  if (updates.status !== undefined && updates.status !== current.status) {
    if (!isValidTransition(current.status, updates.status)) {
      // Stage 3: populate `lastTransitionError` so the agent and UI can observe
      // and self-correct. Write and log fire together only when the message
      // changed — an agent retrying the same invalid transition repeatedly
      // writes zero records and emits zero warnings beyond the first.
      const message = formatTransitionError(current.status, updates.status);
      if (current.lastTransitionError !== message) {
        log.warn(
          { contributionId: id, from: current.status, to: updates.status, message },
          'Rejected invalid state transition',
        );
        const withError: ConnectorContribution = {
          ...current,
          lastTransitionError: message,
          updatedAt: new Date().toISOString(),
        };
        const newContributionsForError = [...contributions];
        newContributionsForError[index] = withError;
        saveContributions(newContributionsForError);
      }
      return null;
    }
  }

  // Stage 3: clear `lastTransitionError` on any successful status transition.
  // Note: same-status calls are short-circuited by the Stage 2 no-op guard
  // above and don't reach this point, so the clearing semantic is strictly
  // "new-state transition clears, no-op doesn't" — callers that want to clear
  // the error while expressing "I'm still at this status" must pass
  // `lastTransitionError: undefined` explicitly (which breaks the no-op
  // predicate and falls through to this write path).
  const isStatusTransitioning = updates.status !== undefined && updates.status !== current.status;

  const applyNullableField = (
    field: 'attributionName' | 'relayContributionId',
  ): { clear: boolean; value?: string } => {
    if (!Object.prototype.hasOwnProperty.call(updates, field)) {
      return { clear: false };
    }
    const value = updates[field];
    if (value === null) {
      return { clear: true };
    }
    if (typeof value === 'string') {
      return { clear: false, value };
    }
    return { clear: false };
  };

  const {
    attributionName: _updatesAttributionName,
    relayContributionId: _updatesRelayContributionId,
    ...updatesWithoutNullableFields
  } = updates;
  // We split nullable fields so the spread doesn't inject `<field>: null` into
  // the merged ConnectorContribution. Null is the "delete field" sentinel.
  const attributionNameMutation = applyNullableField('attributionName');
  const relayContributionIdMutation = applyNullableField('relayContributionId');

  const updated: ConnectorContribution = {
    ...current,
    ...updatesWithoutNullableFields,
    id: current.id, // Ensure ID cannot be changed
    createdAt: current.createdAt, // Ensure createdAt cannot be changed
    acknowledgedEvents: current.acknowledgedEvents, // Use acknowledgeEvent() instead
    updatedAt: new Date().toISOString(),
    // Explicit clearing on successful transition takes precedence over anything
    // in `updates`. This means `updateContribution(id, {status: nextValid})`
    // always clears any stale error even if the caller forgot to pass it.
    ...(isStatusTransitioning ? { lastTransitionError: undefined } : {}),
    ...(attributionNameMutation.value !== undefined
      ? { attributionName: _updatesAttributionName as string }
      : {}),
    ...(relayContributionIdMutation.value !== undefined
      ? { relayContributionId: _updatesRelayContributionId as string }
      : {}),
  };

  if (
    isStatusTransitioning
    && updates.status !== undefined
    && closesBuildWindow(updates.status)
    && current.turnIndexWindow?.endTurn === null
  ) {
    const closeTurn = deriveCurrentSessionTurnIndex(
      current.sessionId,
      current.turnIndexWindow.startTurn,
    );
    updated.turnIndexWindow = {
      ...current.turnIndexWindow,
      endTurn: closeTurn,
    };
  }

  if (attributionNameMutation.clear) {
    delete updated.attributionName;
  }
  if (relayContributionIdMutation.clear) {
    delete updated.relayContributionId;
  }

  const newContributions = [...contributions];
  newContributions[index] = updated;
  saveContributions(newContributions);

  if (isStatusTransitioning) {
    log.info(
      { contributionId: id, from: current.status, to: updates.status },
      'Contribution status transitioned',
    );
  }

  return updated;
}

/**
 * List all contributions.
 */
export function listContributions(): ConnectorContribution[] {
  return loadContributions();
}

/**
 * Permanently delete a contribution record. Used by the Settings stuck-contribution
 * recovery affordance — operator-initiated cleanup of records that didn't promote
 * via normal paths (e.g. a `testing` record whose agent never surfaced a
 * promotion signal). Returns true if the record existed and was deleted, false
 * if no matching record was found.
 *
 * No state-transition validation is applied — deletion is an operator-level
 * escape hatch, not a lifecycle transition. Connector files on disk are NOT
 * affected.
 */
export function deleteContribution(id: string): boolean {
  const contributions = loadContributions();
  const next = contributions.filter((c) => c.id !== id);
  if (next.length === contributions.length) {
    return false;
  }
  saveContributions(next);
  log.info({ contributionId: id }, 'Contribution deleted via operator action');
  return true;
}

// ─── Acknowledgment (per-surface dismissal) ─────────────────────────

/**
 * Acknowledge a status event on a specific UI surface.
 * This tracks that the user has seen/dismissed the notification on that surface,
 * without suppressing the same or other events on other surfaces.
 */
export function acknowledgeEvent(
  contributionId: string,
  status: ContributionStatus,
  surface: AcknowledgmentSurface,
): void {
  const contributions = loadContributions();
  const index = contributions.findIndex((c) => c.id === contributionId);

  if (index === -1) {
    log.warn({ contributionId }, 'Cannot acknowledge event: contribution not found');
    return;
  }

  const current = contributions[index];
  const alreadyAcknowledged = current.acknowledgedEvents.some(
    (e) => e.status === status && e.surface === surface,
  );

  if (alreadyAcknowledged) {
    return; // Idempotent
  }

  const updated: ConnectorContribution = {
    ...current,
    acknowledgedEvents: [
      ...current.acknowledgedEvents,
      { status, surface, at: new Date().toISOString() },
    ],
    updatedAt: new Date().toISOString(),
  };

  const newContributions = [...contributions];
  newContributions[index] = updated;
  saveContributions(newContributions);

  log.info({ contributionId, status, surface }, 'Acknowledged contribution event');
}

/**
 * Check if a specific event has been acknowledged on a specific surface.
 */
export function isEventAcknowledged(
  contributionId: string,
  status: ContributionStatus,
  surface: AcknowledgmentSurface,
): boolean {
  const contribution = getContributionById(contributionId);
  if (!contribution) return false;

  return contribution.acknowledgedEvents.some(
    (e) => e.status === status && e.surface === surface,
  );
}

// ─── Linked Sessions (Stage 2.C, 260426) ────────────────────────────

/**
 * Append `sessionId` to a contribution's `linkedSessionIds` array.
 *
 * Idempotent — re-adding an existing session is a no-op (returns the
 * unchanged record without bumping `updatedAt`). The originating sessionId
 * always remains at index `[0]`; subsequent appends preserve first-seen
 * order. `followUpSessionIds` is kept in sync as `linkedSessionIds.slice(1)`
 * during the Stage 2 → Stage 3 transition window.
 *
 * Stage 2.C (260426): replaces the legacy `addFollowUpSession`-only write
 * path with explicit linked-session semantics. Touch points: bridge
 * `/contribution/report-state` cross-session append, mcpBuildAutoDetectHook
 * existing-record paths.
 *
 * @param contributionId - The contribution to append the session to.
 * @param sessionId      - The session ID to append.
 * @returns The updated contribution, or `undefined` if the contribution was
 *          not found.
 */
export function addLinkedSession(
  contributionId: string,
  sessionId: string,
): ConnectorContribution | undefined {
  const contributions = loadContributions();
  const index = contributions.findIndex((c) => c.id === contributionId);

  if (index === -1) {
    log.warn({ contributionId }, 'Cannot add linked session: contribution not found');
    return undefined;
  }

  const current = contributions[index];
  const existing = current.linkedSessionIds ?? [];

  // Idempotent — don't add duplicate session IDs.
  if (existing.includes(sessionId)) {
    return current;
  }

  const nextLinked = [...existing, sessionId];
  // Keep the deprecated `followUpSessionIds` view in sync for one release
  // (Stage 3 will remove the redundant field once renderer/Settings consumers
  // migrate). The originator at `[0]` stays out of the followUp slice.
  const nextFollowUps = nextLinked.slice(1);
  const updated: ConnectorContribution = {
    ...current,
    linkedSessionIds: nextLinked,
    followUpSessionIds: nextFollowUps,
    updatedAt: new Date().toISOString(),
  };

  const newContributions = [...contributions];
  newContributions[index] = updated;
  saveContributions(newContributions);

  log.info(
    {
      contributionId,
      sessionId,
      totalLinkedSessions: nextLinked.length,
    },
    'Added linked session to contribution',
  );

  return updated;
}

// ─── Stage 3.C (260426): readiness write helpers ────────────────────

/**
 * Atomic field-specific write helper for `lastBuildDetectedAt`.
 *
 * Field-specific (rather than a generic `updateReadinessFields`) by design:
 * keeps the call site readable in the observation reducer (Stage 3.D),
 * gives `grep` a tractable audit trail ("where do we ever clear / set
 * `lastTestPassedAt`?"), and prevents a malformed bulk-update from
 * accidentally clobbering unrelated readiness fields.
 *
 * Bumps `updatedAt`. Idempotent at the value layer (re-writing the same
 * timestamp is a write but does not change semantics). Only the
 * observation service is expected to call this — direct callers bypass
 * the per-canonical-path mutex and the fingerprint check.
 *
 * @returns the updated record, or `undefined` if the record was not found.
 *
 * @see docs/plans/260426_foolproof_contribution_flow_stage3.md § 3.C, Decision 2
 */
export function setLastBuildDetectedAt(
  id: string,
  isoTimestamp: string,
): ConnectorContribution | undefined {
  return writeReadinessField(id, 'lastBuildDetectedAt', isoTimestamp);
}

/**
 * Atomic field-specific write helper for `lastTestPassedAt`.
 *
 * Cleared by `clearStaleReadinessOnFingerprintChange` when a fingerprint
 * mismatch indicates the test was against a different build.
 *
 * @see setLastBuildDetectedAt — same shape, separate field for audit clarity.
 */
export function setLastTestPassedAt(
  id: string,
  isoTimestamp: string,
): ConnectorContribution | undefined {
  return writeReadinessField(id, 'lastTestPassedAt', isoTimestamp);
}

/**
 * Atomic field-specific write helper for `lastRegisteredAt`.
 *
 * Real-world fact (MCP-config registration observed) — not cleared on
 * fingerprint mismatch.
 *
 * @see setLastBuildDetectedAt — same shape, separate field for audit clarity.
 */
export function setLastRegisteredAt(
  id: string,
  isoTimestamp: string,
): ConnectorContribution | undefined {
  return writeReadinessField(id, 'lastRegisteredAt', isoTimestamp);
}

/**
 * Atomic field-specific write helper for `lastReadyRequestedAt`.
 *
 * The agent's own intent — supersedes the legacy in-memory agent-tool-call
 * signal that Stage 3.F deleted. Cleared by
 * `clearStaleReadinessOnFingerprintChange` when a fingerprint mismatch
 * indicates the assertion was against a different build.
 *
 * @see setLastBuildDetectedAt — same shape, separate field for audit clarity.
 */
export function setLastReadyRequestedAt(
  id: string,
  isoTimestamp: string,
): ConnectorContribution | undefined {
  return writeReadinessField(id, 'lastReadyRequestedAt', isoTimestamp);
}

/**
 * Atomic field-specific write helper for `lastBuildFingerprint`.
 *
 * The fingerprint itself is computed by the observation service — see
 * `contributionObservationService::computeBuildFingerprint` (Stage 3.D).
 * Mismatch detection is performed by
 * `clearStaleReadinessOnFingerprintChange` below.
 *
 * @see setLastBuildDetectedAt — same shape, separate field for audit clarity.
 */
export function setLastBuildFingerprint(
  id: string,
  fingerprint: string,
): ConnectorContribution | undefined {
  return writeReadinessField(id, 'lastBuildFingerprint', fingerprint);
}

/**
 * Stage 2 (260428): atomic write helper for `turnIndexWindow`.
 */
export function setTurnIndexWindow(
  id: string,
  window: ContributionTurnIndexWindow,
): ConnectorContribution | undefined {
  const contributions = loadContributions();
  const index = contributions.findIndex((c) => c.id === id);
  if (index === -1) {
    log.warn({ contributionId: id }, 'Cannot set turnIndexWindow: contribution not found');
    return undefined;
  }

  const current = contributions[index];
  const updated: ConnectorContribution = {
    ...current,
    turnIndexWindow: window,
    updatedAt: new Date().toISOString(),
  };

  const next = [...contributions];
  next[index] = updated;
  saveContributions(next);
  log.info({ contributionId: id, turnIndexWindow: window }, 'Set turnIndexWindow on contribution');
  return updated;
}

/**
 * Stage 2 (260428): atomic write helper for SE completion timestamp.
 */
export function setLastSoftwareEngineerTaskCompletedAt(
  id: string,
  isoTimestamp: string,
): ConnectorContribution | undefined {
  return writeSeField(id, { lastSoftwareEngineerTaskCompletedAt: isoTimestamp });
}

/**
 * Stage 2 (260428): clears SE completion timestamp.
 */
export function clearLastSoftwareEngineerTaskCompletedAt(
  id: string,
): ConnectorContribution | undefined {
  return writeSeField(id, { clearLastSoftwareEngineerTaskCompletedAt: true });
}

/**
 * Stage 2 (260428): writes SE evidence invalidation metadata.
 */
export function setSoftwareEngineerEvidenceInvalidation(
  id: string,
  args: {
    at: string;
    reason: SoftwareEngineerEvidenceInvalidatedReason;
  },
): ConnectorContribution | undefined {
  return writeSeField(id, {
    lastSoftwareEngineerEvidenceInvalidatedAt: args.at,
    lastSoftwareEngineerEvidenceInvalidatedReason: args.reason,
  });
}

/**
 * Stage 2 (260428): clears SE evidence invalidation metadata.
 */
export function clearSoftwareEngineerEvidenceInvalidation(
  id: string,
): ConnectorContribution | undefined {
  return writeSeField(id, { clearSoftwareEngineerEvidenceInvalidation: true });
}

/**
 * Self-block follow-on (260427) — sub-stage C. Atomic flag-write helper
 * for `stuckRegistrationNudgeFiredAt`. Idempotent at the value layer
 * (re-stamping the same timestamp is a write but doesn't change
 * semantics). The post-turn sweep in `mcpBuildAutoDetectHook` already
 * guards against re-firing via `!stuckRegistrationNudgeFiredAt` in its
 * predicate, so callers can assume the helper is invoked only once per
 * (contribution, session).
 *
 * @returns the updated record, or `undefined` if the record was not found.
 *
 * @see docs/plans/260427_contribution_flow_followon_self_block_at_registration.md § C
 */
export function markStuckRegistrationNudgeFired(
  id: string,
  isoTimestamp: string,
): ConnectorContribution | undefined {
  const contributions = loadContributions();
  const index = contributions.findIndex((c) => c.id === id);
  if (index === -1) {
    log.warn(
      { contributionId: id },
      'Cannot mark stuck-registration nudge fired: contribution not found',
    );
    return undefined;
  }

  const current = contributions[index];
  const updated: ConnectorContribution = {
    ...current,
    stuckRegistrationNudgeFiredAt: isoTimestamp,
    updatedAt: new Date().toISOString(),
  };

  const newContributions = [...contributions];
  newContributions[index] = updated;
  saveContributions(newContributions);

  log.info(
    { contributionId: id, firedAt: isoTimestamp },
    'Marked stuck-registration nudge fired on contribution',
  );

  return updated;
}

/** Internal helper backing the five `setLast*` helpers above. */
function writeReadinessField(
  id: string,
  field:
    | 'lastBuildDetectedAt'
    | 'lastTestPassedAt'
    | 'lastRegisteredAt'
    | 'lastReadyRequestedAt'
    | 'lastBuildFingerprint',
  value: string,
): ConnectorContribution | undefined {
  const contributions = loadContributions();
  const index = contributions.findIndex((c) => c.id === id);
  if (index === -1) {
    log.warn(
      { contributionId: id, field },
      'Cannot set readiness field: contribution not found',
    );
    return undefined;
  }

  const current = contributions[index];
  const updated: ConnectorContribution = {
    ...current,
    [field]: value,
    updatedAt: new Date().toISOString(),
  };

  const newContributions = [...contributions];
  newContributions[index] = updated;
  saveContributions(newContributions);

  log.info(
    { contributionId: id, field, value },
    'Set readiness field on contribution',
  );

  return updated;
}

function writeSeField(
  id: string,
  updates: {
    lastSoftwareEngineerTaskCompletedAt?: string;
    lastSoftwareEngineerEvidenceInvalidatedAt?: string;
    lastSoftwareEngineerEvidenceInvalidatedReason?: SoftwareEngineerEvidenceInvalidatedReason;
    clearLastSoftwareEngineerTaskCompletedAt?: boolean;
    clearSoftwareEngineerEvidenceInvalidation?: boolean;
  },
): ConnectorContribution | undefined {
  const contributions = loadContributions();
  const index = contributions.findIndex((c) => c.id === id);
  if (index === -1) {
    log.warn({ contributionId: id }, 'Cannot write SE evidence fields: contribution not found');
    return undefined;
  }

  const current = contributions[index];
  const updated: ConnectorContribution = {
    ...current,
    updatedAt: new Date().toISOString(),
    ...(updates.lastSoftwareEngineerTaskCompletedAt !== undefined
      ? { lastSoftwareEngineerTaskCompletedAt: updates.lastSoftwareEngineerTaskCompletedAt }
      : {}),
    ...(updates.lastSoftwareEngineerEvidenceInvalidatedAt !== undefined
      ? { lastSoftwareEngineerEvidenceInvalidatedAt: updates.lastSoftwareEngineerEvidenceInvalidatedAt }
      : {}),
    ...(updates.lastSoftwareEngineerEvidenceInvalidatedReason !== undefined
      ? { lastSoftwareEngineerEvidenceInvalidatedReason: updates.lastSoftwareEngineerEvidenceInvalidatedReason }
      : {}),
  };

  if (updates.clearLastSoftwareEngineerTaskCompletedAt) {
    delete updated.lastSoftwareEngineerTaskCompletedAt;
  }
  if (updates.clearSoftwareEngineerEvidenceInvalidation) {
    delete updated.lastSoftwareEngineerEvidenceInvalidatedAt;
    delete updated.lastSoftwareEngineerEvidenceInvalidatedReason;
  }

  const next = [...contributions];
  next[index] = updated;
  saveContributions(next);
  log.info(
    {
      contributionId: id,
      updatedFields: {
        lastSoftwareEngineerTaskCompletedAt: updates.lastSoftwareEngineerTaskCompletedAt,
        lastSoftwareEngineerEvidenceInvalidatedAt: updates.lastSoftwareEngineerEvidenceInvalidatedAt,
        lastSoftwareEngineerEvidenceInvalidatedReason: updates.lastSoftwareEngineerEvidenceInvalidatedReason,
        clearLastSoftwareEngineerTaskCompletedAt: updates.clearLastSoftwareEngineerTaskCompletedAt === true,
        clearSoftwareEngineerEvidenceInvalidation: updates.clearSoftwareEngineerEvidenceInvalidation === true,
      },
    },
    'Updated SE evidence fields on contribution',
  );
  return updated;
}

/**
 * Apply fingerprint-mismatch invalidation: when the freshly-observed
 * `newFingerprint` differs from the record's stored `lastBuildFingerprint`,
 * clear `lastTestPassedAt` and `lastReadyRequestedAt` (the agent's
 * assertions about the OLD build are now stale) and persist
 * `lastBuildFingerprint = newFingerprint`.
 *
 * Crucially does NOT clear `lastBuildDetectedAt` or `lastRegisteredAt` —
 * those are real-world facts (mtime change observed; MCP-config presence)
 * that DON'T become wrong when the build content changes.
 *
 * No-op cases (record returned unchanged, no log fires):
 *   - record not found.
 *   - existing fingerprint is undefined (nothing to invalidate; the caller
 *     should follow up with `setLastBuildFingerprint` if it wants to stamp
 *     the fresh fingerprint).
 *   - existing fingerprint equals `newFingerprint` (no mismatch).
 *
 * Emits a `warn` breadcrumb on every actual invalidation for observability —
 * this is the user-experience-opaque "your test pass evidence vanished
 * because the build content changed" event from G1 of the Stage 3 plan.
 *
 * @returns the updated record, or `undefined` if the record was not found.
 *
 * @see docs/plans/260426_foolproof_contribution_flow_stage3.md § 3.C, Decision 3
 */
export function clearStaleReadinessOnFingerprintChange(
  id: string,
  newFingerprint: string,
): ConnectorContribution | undefined {
  const contributions = loadContributions();
  const index = contributions.findIndex((c) => c.id === id);
  if (index === -1) {
    log.warn(
      { contributionId: id },
      'Cannot apply fingerprint invalidation: contribution not found',
    );
    return undefined;
  }

  const current = contributions[index];
  const previous = current.lastBuildFingerprint;

  // No-op: nothing to invalidate. Caller is responsible for stamping the
  // first observed fingerprint via `setLastBuildFingerprint`.
  if (previous === undefined) return current;
  // No-op: fingerprints match — readiness stays valid.
  if (previous === newFingerprint) return current;

  const updated: ConnectorContribution = {
    ...current,
    lastBuildFingerprint: newFingerprint,
    updatedAt: new Date().toISOString(),
  };
  // Explicitly delete the agent-asserted readiness fields so the
  // `string | undefined` runtime shape is preserved (a `delete` keeps the
  // record free of `lastTestPassedAt: undefined` artefacts on JSON
  // round-trip).
  delete updated.lastTestPassedAt;
  delete updated.lastReadyRequestedAt;

  const newContributions = [...contributions];
  newContributions[index] = updated;
  saveContributions(newContributions);

  log.warn(
    {
      contributionId: id,
      previousFingerprint: previous,
      newFingerprint,
      breadcrumb: 'contributionStore.fingerprint-invalidation',
    },
    'Build fingerprint changed — cleared lastTestPassedAt + lastReadyRequestedAt',
  );

  return updated;
}

/**
 * Default "stuck" threshold for `getStuckTestingContributions` —
 * matches the legacy `STUCK_AGE_THRESHOLD_MS` from
 * `contributionStartupSweep.ts`. Co-located here so the boot path and the
 * store agree on a single source of truth.
 */
const DEFAULT_STUCK_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Lookup helper for the boot-time observation pipeline (Stage 3.E).
 *
 * Returns all `status === 'testing'` records whose `updatedAt` is older
 * than `now - olderThanMs`. Promoting this to a named lookup (rather than
 * leaving it inline in `contributionStartupSweep.ts`) ensures the boot
 * path doesn't accidentally diverge from production logic when the
 * reducer needs to enumerate stuck records during a coordinated sweep.
 *
 * Default `olderThanMs` (10 minutes) mirrors the legacy
 * `STUCK_AGE_THRESHOLD_MS` from `contributionStartupSweep.ts`. Default
 * `now` is `Date.now()` — both are caller-injectable so reducer / sweep
 * tests can be deterministic.
 *
 * @returns the list of stuck `testing` records (may be empty); ordering
 *          is the underlying `listContributions()` order (insertion order).
 *
 * @see docs/plans/260426_foolproof_contribution_flow_stage3.md § 3.C, Decision 4
 */
export function getStuckTestingContributions(
  options?: { olderThanMs?: number; now?: number },
): ConnectorContribution[] {
  const olderThanMs = options?.olderThanMs ?? DEFAULT_STUCK_THRESHOLD_MS;
  const now = options?.now ?? Date.now();
  const cutoff = now - olderThanMs;
  const contributions = loadContributions();
  return contributions.filter((c) => {
    if (c.status !== 'testing') return false;
    const updatedAtMs = Date.parse(c.updatedAt);
    if (Number.isNaN(updatedAtMs)) {
      // Defensive: a malformed timestamp shouldn't hide the record from the
      // sweep. Return true so the boot path can re-stamp via observation.
      return true;
    }
    return updatedAtMs <= cutoff;
  });
}

// ─── Follow-Up Sessions (compat wrapper) ────────────────────────────

/**
 * Add a follow-up session ID to a contribution record.
 *
 * Stage 2.C (260426): now delegates to `addLinkedSession`. The function name
 * survives because it's used by the IPC handler
 * (`contribution:link-follow-up-session`) and the renderer's "spawn
 * follow-up conversation" flow. Both `linkedSessionIds` and
 * `followUpSessionIds` (the derived view) are kept in sync.
 *
 * @param contributionId - The contribution to link the follow-up session to.
 * @param followUpSessionId - The new follow-up session ID.
 * @returns The updated contribution, or undefined on error.
 */
export function addFollowUpSession(
  contributionId: string,
  followUpSessionId: string,
): ConnectorContribution | undefined {
  return addLinkedSession(contributionId, followUpSessionId);
}

// ─── Testing ────────────────────────────────────────────────────────

/** Reset store for testing. */
export function _resetStore(): void {
  _store = null;
  _storeInitialized = false;
  _cachedState = null;
  _awaitingHydratedLoadAfterFdExhaustion = false;
}
