/**
 * Incremental Session Store
 *
 * File-per-session architecture for efficient saves.
 * Instead of writing all 219 sessions (99MB) on every save,
 * writes only changed sessions based on fingerprint comparison.
 *
 * Key features:
 * - Fingerprint-based change detection (no deep comparison needed)
 * - Individual session files in userData/sessions/
 * - Lightweight index for metadata-only queries
 * - Automatic migration from legacy single-file format
 * - Index recovery if corrupted/missing
 *
 * This store holds the single derive-then-stamp choke point for turn-liveness:
 * `isBusy`/`activeTurnId` are a recomputed cache written only via the stamp API.
 *
 * @see docs/plans/finished/260101_incremental_session_saves.md
 * @see docs/project/UI_CONVERSATIONS.md — Turn-liveness projection (Intent & Design Rationale)
 */

import { writeFile, writeFileSync } from 'atomically';
import * as fs from 'fs';
import * as path from 'path';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { getErrorMessage } from '@core/utils/getErrorMessage';
import { mapWithConcurrencyLimit } from '@core/utils/concurrencyLimit';
import {
  isTooManyOpenFilesError,
  withRetryOnEmfile,
  withSingleSyncRetryOnEmfile,
} from '@core/utils/emfileRetry';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { getDataPath } from '../utils/dataPaths';
import { MAX_PERSISTED_SESSIONS } from '../constants';
import type { AgentEvent, AgentSession, AgentSessionSummary, MemoryUpdateStatus, TimeSavedStatus } from '@shared/types';
import { isDeleteEligibleSession, isSidebarHiddenSession } from '@shared/sessionKind';
import { isSessionActive, isSessionDone } from '@rebel/shared';
import { markSessionTurnsAsCompleted } from './inboxStore';
import { hasTerminalEventInTurn } from './sessionMergeUtils';
import { getContentEquivalenceKey } from '@shared/utils/eventIdentity';
import { applyInterruptedTurnCorrection } from './sessionTurnRecovery';
import { projectSessionSummaryFields } from './sessionSummaryProjection';
import { getMaxSeqFromSession, getSessionSeqIndex } from './sessionSeqIndex';
import { deriveTurnLiveness, toPersistedBusyScalars } from './conversationState';
import { isUserDataReadOnly } from '@core/userDataWriteGate';
import { getAssetStore } from '@core/assetStore';
import { recordAssetResolutionFailure } from './assetResolutionObservability';
import { sanitizeEventForMainAccumulation } from '@shared/utils/eventSanitization';

const log = createScopedLogger({ service: 'incrementalSessionStore' });

const ORPHAN_MEMORY_UPDATE_ERROR =
  "Memory wasn't fully saved before the app closed. No data lost — newer turns will pick it up.";

/**
 * Grace window for in-flight BTS memory-update "running" statuses.
 *
 * The hydration sanitizer (see `sanitizeOrphanRunningMemoryUpdateStatuses`)
 * cannot tell a genuinely orphaned "running" status (crash recovery) apart
 * from a legitimately in-flight BTS turn that hasn't finished yet. Comparing
 * the status timestamp against this grace window lets us preserve still-running
 * BTS turns while still eventually cleaning up post-crash orphans.
 *
 * 30 minutes is ~6x the realistic worst-case BTS memory-update duration
 * (~5 min observed) — enough margin that we won't false-positive a slow turn,
 * but short enough that post-crash orphans don't linger as "running" forever.
 *
 * See docs/plans/260518_orphan_memory_update_grace_period.md.
 */
const ORPHAN_RUNNING_GRACE_MS = 30 * 60 * 1000;

export const MAX_SESSION_ASSETS = 1000;
export const MAX_SESSION_ASSET_BYTES = 1_000_000_000;

type QuotaCheckResult =
  | { status: 'within' }
  | { status: 'warning'; warning: NonNullable<AgentSession['quotaWarning']> }
  | { status: 'unavailable'; error?: unknown };

export interface CleanupLeakedSessionsSummary {
  scanned: number;
  deleted: number;
  errors: number;
  sampleDeletedIds: string[];
  /**
   * Delete-eligible sessions left for a later startup because this pass hit
   * the per-pass safety cap (Stage 2 cap-and-continue policy — see the remover
   * taxonomy at computeBulkRemovalBound()). 0 when the backlog fit in one pass.
   */
  deferredBeyondCap: number;
}

export interface CleanupLeakedSessionDeletedMetadata {
  source: 'cleanupLeakedSessions';
}

export interface ListSessionsOptions {
  /** Include delete-eligible internal sessions (memory-update/meeting-qa/error-eval/calendar-sync). */
  includeInternal?: boolean;
}

interface CleanupLeakedSessionsOptions {
  /** Optional callback used by startup flows to enqueue cloud tombstones on delete. */
  onSessionDeletedLocally?: (
    sessionId: string,
    metadata: CleanupLeakedSessionDeletedMetadata,
  ) => void | Promise<void>;
}

/** Read-only mode: set when userData was last written by a newer app version.
 *  Also checks the global userDataWriteGate (set in bootstrap before stores load). */
let sessionStoreReadOnlyMode = false;
let cleanupInFlight: Promise<CleanupLeakedSessionsSummary> | null = null;

/**
 * Stage 2 safety-net guard counters (docs/plans/260612_recs-round5/PLAN.md).
 *
 * Internal observability counters included in the structured error logs and
 * Sentry captures emitted by the safety nets below. They are intentionally NOT
 * exported — consumers observe them through log/Sentry payloads (a future
 * health-check wiring can snapshot them if a numbers-only check is added).
 */
const sessionStoreSafetyCounters = {
  /** Mass-loss circuit breaker trips (recovery-class bulk removal refused). */
  bulkRemovalBreakerTrips: 0,
  /** Times the store entered protective read-only mode (any reason). */
  protectiveReadOnlyEntries: 0,
  /** cleanupLeakedSessions passes that hit the per-pass cap and deferred work. */
  cleanupLeakedSessionsCapDeferrals: 0,
  /** Backup-on-write skipped because the existing primary index was invalid. */
  backupSkippedInvalidPrimaryCount: 0,
  /** index.json recovered from index.json.bak (primary missing/corrupt). */
  indexRecoveredFromBackupCount: 0,
  /** Reload-upserts aborted because primary AND backup index were unusable. */
  reloadUpsertAbortedCorruptIndexCount: 0,
  /** Reload-upserts aborted because the on-disk index is from a NEWER app. */
  reloadUpsertAbortedVersionForwardCount: 0,
  /**
   * Reload-upserts deferred because index.json was present but TRANSIENTLY
   * unreadable (EMFILE/ENFILE/transient IO). NOT corruption — the write is
   * dropped and the on-disk index is left untouched (REBEL-1C8 class).
   */
  reloadUpsertTransientIndexReadCount: 0,
  /**
   * Full loads (load/loadSync) that degraded because index.json was present but
   * TRANSIENTLY unreadable — kept the in-memory index / returned empty WITHOUT
   * rebuilding or .bak-recovering a possibly-healthy index.
   */
  loadTransientIndexReadCount: 0,
  /**
   * Transient-degrade attempts that served index.json.bak IN MEMORY (no primary
   * write) instead of an empty sidebar (F2a).
   */
  loadTransientServedFromBackupCount: 0,
  /**
   * Async single upserts that DEFERRED the index write because the on-disk index
   * was present but transiently unreadable during reload (F1) — the session FILE
   * was written; the index write was skipped to avoid shrinking the corpus.
   */
  upsertDeferredTransientIndexReadCount: 0,
  /**
   * Index writes (writeIndex/writeIndexSync — incl. migration paths) that
   * DEFERRED because the in-memory base was null AND the on-disk primary was
   * transiently unreadable, so a base-less merge would have shrunk a healthy
   * primary (REBEL-1C8 round-4 class fix).
   */
  indexWriteDeferredTransientBaseCount: 0,
};

type ProtectiveReadOnlyReason =
  | 'index-version-forward'
  | 'bulk-removal-breaker'
  | 'reload-upsert-corrupt-index'
  | 'reload-upsert-version-forward';

/**
 * SINGLE LOUD CHOKEPOINT for every PROTECTIVE read-only entry (Stage 2 item 4,
 * FMM C-19): a read-only store silently drops all writes, so entering the mode
 * must never be silent. Emits a structured `log.error`, a Sentry capture, and
 * increments the guard counters.
 *
 * PERSISTENT-TRIP STORY (C-19, pinned by test): a persistent trigger — e.g.
 * more-than-bound index rows whose session files genuinely vanished, or a
 * corrupt index with no usable backup — re-fires this chokepoint at EVERY boot.
 * That every-boot loop is the intended, loud, observable state (one error log +
 * one Sentry event per boot), NOT a bug to suppress. Manual recovery: restore
 * the missing session files, repair/delete `sessions/index.json` (a deleted
 * index rebuilds from the session files on disk), or restore it from
 * `sessions/index.json.bak`; then restart the app.
 *
 * Intentional NON-callers (read-only entries that are not degradations):
 *  - finalizeActiveSessionsOnShutdown(): the shutdown latch deliberately locks
 *    the store on every graceful quit — routing it here would page Sentry on
 *    every clean exit.
 *  - setReadOnlyMode(): external policy (version-marker downgrade protection)
 *    owned and logged by the caller in main.
 */
function enterProtectiveReadOnlyMode(
  reason: ProtectiveReadOnlyReason,
  message: string,
  context: Record<string, unknown>,
): void {
  sessionStoreSafetyCounters.protectiveReadOnlyEntries += 1;
  sessionStoreReadOnlyMode = true;
  log.error(
    { reason, ...context, safetyCounters: { ...sessionStoreSafetyCounters } },
    message,
  );
  getErrorReporter().captureMessage('Session store entered protective read-only mode', {
    level: 'error',
    fingerprint: ['session-store-protective-read-only', reason],
    tags: { reason },
    extra: { ...context, safetyCounters: { ...sessionStoreSafetyCounters }, detail: message },
  });
}

/**
 * MASS-LOSS CIRCUIT BREAKER bounds (Stage 2 item 1; DEFERRAL §4).
 *
 * Every bulk path that removes/prunes/drops sessions in aggregate consults
 * `computeBulkRemovalBound()` BEFORE acting. The bound encodes the invariant:
 * "removing a large fraction of a non-trivial corpus is ALWAYS a bug, never a
 * legitimate maintenance op."
 *
 *  - BULK_REMOVAL_ABSOLUTE_FLOOR: always allow removing up to this many
 *    sessions regardless of fraction (legitimate cleanups are tiny — 1-2 ids in
 *    practice; 25 is generous headroom).
 *  - BULK_REMOVAL_MAX_FRACTION: above the floor, never let a single bulk op
 *    remove more than this fraction of the corpus being considered.
 *
 * Effective bound: `max(25, ceil(total * 0.01))`.
 *
 * REMOVER TAXONOMY (Stage 2 ruling 4 — trip semantics by remover class):
 *  - RECOVERY-CLASS paths (no user intent present) → trip ⇒ abort to read-only
 *    via `guardRecoveryClassBulkRemoval()`: index-entry prune on load
 *    (loadFromNewFormat[Sync]), rebuild-from-files prune
 *    (rebuildIndexFromFiles[Sync]), and any future orphan-recovery quarantine.
 *    Bulk removal is never legitimate here; read-only-preserve-everything is
 *    correct. Migration-time cleanup is non-destructive BY CONSTRUCTION since
 *    Stage 2 (migrateFromLegacy renames to a backup instead of rm'ing).
 *  - cleanupLeakedSessions() → per-pass CAP + loud telemetry + CONTINUE: it
 *    runs one-shot at startup with no retry wake, so a read-only trip would be
 *    a PERMANENT every-boot read-only loop. It deletes at most the bound per
 *    pass and converges across startups. It NEVER sets read-only — structurally
 *    it only uses the pure `computeBulkRemovalBound()`, never the tripping
 *    guard (pinned by test).
 *  - evictIfNeeded() → EXEMPT: eviction deliberately removes the oldest
 *    (count − MAX_PERSISTED_SESSIONS) sessions, a count that can legitimately
 *    exceed the bound; it has its own over-cap-only invariant (it may only ever
 *    remove sessions strictly OVER the cap) and must not be subject to this
 *    bound.
 *  - purgeDeletedSessions() (cloudDataHygieneService) → EXEMPT-WITH-REASON: it
 *    unlinks only already-soft-deleted files in `sessions-deleted/` past their
 *    TTL — never live `sessions/` files and never the index.
 *  - cleanupOrphanStatusEntries() → NOT A SESSION REMOVER: it prunes orphaned
 *    status entries INSIDE a session object during hydration; it never removes
 *    sessions or index rows, so it is excluded from this taxonomy.
 */
const BULK_REMOVAL_ABSOLUTE_FLOOR = 25;
const BULK_REMOVAL_MAX_FRACTION = 0.01;

/**
 * Concurrency ceiling for the session-store filesystem fan-outs (load, prep,
 * write, asset-quota). Defense-in-depth against libuv-threadpool saturation —
 * see docs-private/postmortems/260617_dns_threadpool_starvation_connect_timeouts_postmortem.md
 * and docs/plans/260617_session-store-fanout-bound/PLAN.md.
 *
 * The incident: Node resolves outbound DNS (`dns.lookup`/getaddrinfo) on the
 * 4-thread libuv pool. A cold load of thousands of sessions previously fanned
 * out an UNBOUNDED `Promise.all` of `fs.readFile`s onto that same pool, queuing
 * DNS behind file I/O → app-wide connect timeouts. The root cause was fixed by
 * moving DNS off the pool (c-ares); bounding these fan-outs is the deferred
 * defense-in-depth so a future regression (or another pool consumer) can't
 * re-saturate it.
 *
 * 8 sits ABOVE the default pool size (4) so steady-state load/save keep their
 * parallelism (these paths were fully parallel before, so we don't want to add
 * latency), while still capping the worst case — a 2,895-session cold load can
 * no longer issue 2,895 concurrent reads. It is in the same band as the other
 * fs fan-out limits in this codebase (3–16). Bounding is semantics-preserving:
 * `mapWithConcurrencyLimit` preserves result order identically to `Promise.all`
 * (pinned by src/core/utils/__tests__/concurrencyLimit.test.ts). The one place
 * where a bounded pool is NOT a drop-in for `Promise.all` is failure handling —
 * see the WRITE-FAILURE CONTRACT comment in `flush()`.
 */
const SESSION_STORE_FS_CONCURRENCY = 8;

/**
 * Stage 3 self-heal threshold (docs/plans/260616_folders-appear-empty-index-collapse/PLAN.md).
 *
 * `loadIndexOnlySync` is the fast startup path: it adopts a current-version
 * index as-is with NO orphan scan and NO session-file reads. That is exactly why
 * a COLLAPSED-but-valid index (e.g. 67 entries while ~2,882 valid session files
 * exist on disk — the reported incident) never self-heals: the fast path keeps
 * re-adopting the truncated index every startup, and the orphan-recovery that
 * would re-add the missing files only runs on the full-load path.
 *
 * The guard does a cheap directory-listing-only orphan count (no file reads) and,
 * if the number of on-disk session files MISSING from the index clearly signals a
 * collapse, falls through to the full load so `loadFromNewFormatSync` orphan
 * recovery repopulates the index.
 *
 * Threshold rationale: a HEALTHY index has orphanCount ≈ 0 — every saved session
 * is written to its file AND the index in the same flush. A small handful of
 * orphans is BENIGN (a crash between the file write and the index write leaves a
 * few; those are recovered by other full-load triggers and must NOT defeat the
 * fast path on every startup). A genuine collapse leaves thousands of orphans.
 * 50 sits comfortably above the benign post-crash handful yet far below any real
 * collapse, so it triggers only on the pathology, never in steady state. It is
 * deliberately aligned with `BULK_REMOVAL_ABSOLUTE_FLOOR` (25) — twice the "this
 * many is always a legitimate cleanup" floor — so "too many orphans to be
 * benign" and "too many removals to be benign" share a consistent order of
 * magnitude.
 */
const SUSPECT_COLLAPSE_ORPHAN_THRESHOLD = 50;

/** Pure bound: `max(25, ceil(total * 0.01))`. See the taxonomy comment above. */
function computeBulkRemovalBound(totalCount: number): number {
  return Math.max(BULK_REMOVAL_ABSOLUTE_FLOOR, Math.ceil(totalCount * BULK_REMOVAL_MAX_FRACTION));
}

export const INDEX_VERSION = 9; // Bumped 8→9 to force a one-time rebuild-from-files that applies migrateResolvedAutomationToDone (260617): resolved automations born without a `pinnedAt` key had no `doneAt` in their files and reverted to Active after the index-collapse rebuild. (8 was: rebuild summaries with the canonical `doneAt` lifecycle field; pinnedAt → doneAt rename; see docs/plans/260614_done-state-rename/PLAN.md)

// hasTerminalEvent logic consolidated into @core/services/sessionMergeUtils (hasTerminalEventInTurn)
// See docs/plans/260409_cloud_continuity_centralization_top10.md — Stage 1

/**
 * Normalize session turn state to fix stale isBusy/activeTurnId.
 * 
 * This fixes a race condition where:
 * 1. Turn completes and terminal event is persisted to eventsByTurn
 * 2. But isBusy/activeTurnId fields weren't updated before persistence snapshot
 * 
 * The fix: If activeTurnId is set but has a terminal event, clear the busy state.
 * This makes the persisted state self-healing - corrupt state auto-corrects on read.
 */
/**
 * WeakSet of sessions whose hydration mutated state (e.g. sanitized orphan
 * `running` memory-update statuses). The load path uses this to skip seeding
 * `cachedFingerprints` for sanitized sessions, ensuring the next save
 * persists the corrected on-disk state instead of leaving the stale value.
 */
const SANITIZED_SESSIONS = new WeakSet<AgentSession>();
const LEGACY_STATUS_LOGGED_SESSION_IDS = new Set<string>();
const LEGACY_MEMORY_STATUS_SESSION_IDS = new Set<string>();
const LEGACY_TIME_SAVED_STATUS_SESSION_IDS = new Set<string>();
let legacyStatusFirstDetectionLogged = false;
/**
 * Session ids whose `messages` field was coerced to `[]` at the load boundary
 * (malformed/partial-write file). Deduped to once-per-session-per-process so a
 * rebuild over thousands of sessions can't log-storm (mirrors
 * LEGACY_STATUS_LOGGED_SESSION_IDS).
 */
const COERCED_MESSAGES_LOGGED_SESSION_IDS = new Set<string>();
/**
 * Session ids whose `eventsByTurn` field was coerced (non-object → {} or a
 * non-array per-turn value → []) at the load boundary. Deduped to
 * once-per-session-per-process (mirrors COERCED_MESSAGES_LOGGED_SESSION_IDS).
 */
const COERCED_EVENTS_BY_TURN_LOGGED_SESSION_IDS = new Set<string>();
/**
 * Session ids whose `createSummary` threw during an index
 * rewrite (Stage 2 containment). Deduped to once-per-session-per-process so a
 * rebuild over thousands of sessions can't log-storm (mirrors
 * LEGACY_STATUS_LOGGED_SESSION_IDS / COERCED_MESSAGES_LOGGED_SESSION_IDS).
 */
const SUMMARY_BUILD_FAILED_LOGGED_SESSION_IDS = new Set<string>();

/**
 * Dedupe set (once per context+filename per process) for the
 * filename-vs-content session-id mismatch warning — a foreign/future sidecar
 * `*.json` in `sessions/` whose content id is missing/mismatched. See
 * `verifyLoadedSessionFileId` (260617 crash root fix).
 */
const NON_SESSION_FILE_ID_MISMATCH_LOGGED = new Set<string>();

/**
 * Returns true if `normalizeSessionTurnState` produced a corrected session
 * (i.e. the on-disk state was stale and has been repaired in memory).
 * Callers should treat such sessions as dirty and trigger a write-back.
 */
export function isSessionSanitizedDuringHydration(session: AgentSession): boolean {
  return SANITIZED_SESSIONS.has(session);
}

export function countUserMessages(session: Pick<AgentSession, 'messages'>): number {
  // Guard the optional/possibly-non-array `messages` field (raw `JSON.parse as
  // AgentSession` bypasses Zod defaults at the ~10 hydration sites). Matches the
  // rest of the summary path (`projectSessionSummaryFields` uses `messages ?? []`,
  // `computeFingerprint` uses `messages?.length ?? 0`). An unguarded `.filter`
  // here on a `messages`-less file once aborted the whole index rebuild
  // (docs/plans/260616_folders-appear-empty-index-collapse/PLAN.md).
  const messages = session.messages;
  if (!Array.isArray(messages)) return 0;
  return messages.filter((message) => message.role === 'user').length;
}

/**
 * One-time on-disk repair for the doubled-result-text artifact described in
 * `docs-private/investigations/260513_duplicate_result_text_in_message_bubble.md`.
 *
 * Scope discipline (per the diagnosis doc):
 *  - Per-turn event repair runs only when `getContentEquivalenceKey` reports a
 *    duplicate pair WITH a seq mismatch (the diagnosis fingerprint).
 *  - Message repair only fires when both:
 *      (a) the event ledger had a corroborating duplicate for that turn, AND
 *      (b) the result-role text matches the exact pattern `<half>\n\n<half>`
 *          where `<half>` equals the surviving assistant event text.
 *  - We NEVER blanket-reverse text doublings without event corroboration —
 *    legitimate repeated prose stays untouched.
 */
/**
 * Backfills `providersSeen: []` on `modelUsage` entries from sessions persisted
 * before the field became required. Raw `JSON.parse as AgentSession` bypasses
 * Zod defaults at the ~10 hydration sites, so without this any consumer that
 * reads `entry.providersSeen.length` un-null-checked would crash on legacy
 * data. Mutates in place; the field's `.default([])` in Zod ensures fresh
 * sessions already have an array.
 */
/**
 * Load-boundary hardening: ensure `messages` is always an array after hydration.
 * Raw `JSON.parse as AgentSession` bypasses Zod defaults at the ~10 hydration
 * sites, so a malformed/partial-write file can carry `messages: undefined` (or a
 * non-array). A `messages`-less file once crashed `countUserMessages` and
 * aborted the whole index rebuild — collapsing the visible session corpus
 * (docs/plans/260616_folders-appear-empty-index-collapse/PLAN.md). Coercing here,
 * the single load-path choke point, protects EVERY summary/load path at once.
 * The coercion is observable (deduped warn) because a missing `messages` array
 * indicates a malformed on-disk file worth investigating.
 *
 * Returns true when coercion actually fired, so the caller can mark the session
 * hydration-mutated (SANITIZED_SESSIONS) — otherwise the fingerprint-seeding skip
 * would never trigger a write-back and the malformed on-disk file would never be
 * repaired (F2).
 */
function coerceMessagesArray(session: AgentSession): boolean {
  if (Array.isArray(session.messages)) return false;
  const sawValue = (session as { messages?: unknown }).messages;
  session.messages = [];
  if (!COERCED_MESSAGES_LOGGED_SESSION_IDS.has(session.id)) {
    COERCED_MESSAGES_LOGGED_SESSION_IDS.add(session.id);
    log.warn(
      { sessionId: session.id, sawType: sawValue === undefined ? 'undefined' : typeof sawValue },
      'session-hydration: coerced non-array `messages` to [] (possible malformed/partial-write session file)',
    );
  }
  return true;
}

/**
 * Load-boundary hardening for `eventsByTurn` (Pathologist Rec 2, by-construction).
 * Mirrors `coerceMessagesArray`: raw `JSON.parse as AgentSession` bypasses Zod
 * defaults, so a malformed file can carry a non-object `eventsByTurn` or a
 * per-turn value that isn't an array. Several summary-path readers iterate it
 * (`aggregateSessionUsage`, `getMaxSeqFromSession`, `deriveTurnLiveness`); a
 * non-iterable value throws — Stage 2 containment catches that, but only as a
 * degraded `isCorrupted` row. Coercing the field here lets such a session
 * summarize NORMALLY instead. Coerces: a non-object `eventsByTurn` → {}, and any
 * per-turn value that isn't an array → []. Observable (deduped warn); returns true
 * when coercion fired so the caller can mark the session hydration-mutated.
 */
function coerceEventsByTurn(session: AgentSession): boolean {
  const raw = (session as { eventsByTurn?: unknown }).eventsByTurn;
  let coerced = false;
  let sawType: string | null = null;

  // The whole field must be a plain object (Record<string, AgentEvent[]>).
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    sawType = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
    session.eventsByTurn = {};
    coerced = true;
  } else {
    // Per-turn values must each be an array of events.
    const map = raw as Record<string, unknown>;
    for (const [turnId, turnEvents] of Object.entries(map)) {
      if (!Array.isArray(turnEvents)) {
        map[turnId] = [];
        coerced = true;
        sawType ??= typeof turnEvents;
      }
    }
  }

  if (coerced && !COERCED_EVENTS_BY_TURN_LOGGED_SESSION_IDS.has(session.id)) {
    COERCED_EVENTS_BY_TURN_LOGGED_SESSION_IDS.add(session.id);
    log.warn(
      { sessionId: session.id, sawType },
      'session-hydration: coerced malformed `eventsByTurn` (non-object → {} / non-array turn value → []) (possible malformed/partial-write session file)',
    );
  }
  return coerced;
}

function backfillModelUsageProvidersSeen(session: AgentSession): void {
  const eventsByTurn = session.eventsByTurn;
  if (!eventsByTurn) return;
  let malformedCount = 0;
  for (const turnEvents of Object.values(eventsByTurn)) {
    if (!Array.isArray(turnEvents)) continue;
    for (const event of turnEvents) {
      const modelUsage = (event as { modelUsage?: unknown }).modelUsage;
      if (!modelUsage || typeof modelUsage !== 'object') continue;
      for (const entry of Object.values(modelUsage as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as { providersSeen?: unknown };
        if (e.providersSeen === undefined) {
          e.providersSeen = [];
        } else if (!Array.isArray(e.providersSeen)) {
          malformedCount += 1;
          e.providersSeen = [];
        }
      }
    }
  }
  if (malformedCount > 0) {
    log.warn(
      { sessionId: session.id, malformedCount },
      'session-hydration: replaced non-array providersSeen values with [] (possible upstream data corruption)',
    );
  }
}

/**
 * EXPAND step of the `pinnedAt` → `doneAt` rename (see
 * docs/plans/260614_done-state-rename/PLAN.md). Idempotently dual-writes the
 * canonical `doneAt` field from the legacy `pinnedAt` field on hydration,
 * mirroring `backfillModelUsageProvidersSeen` (raw `JSON.parse as AgentSession`
 * bypasses Zod defaults at the ~10 hydration sites).
 *
 * CONTRACT step of the `pinnedAt` → `doneAt` rename. Two legacy file shapes
 * still carry the now-removed `pinnedAt` key on disk:
 *   - never-migrated legacy files: `pinnedAt` only, no `doneAt`.
 *   - EXPAND-stage dual-written files: BOTH `pinnedAt` and `doneAt`.
 * Both must lose `pinnedAt` so the on-disk file is rewritten without it.
 *
 * Polarity flip (only needed for never-migrated files): legacy `pinnedAt`
 * non-null = Active, null = Done. New `doneAt` non-null = Done. So:
 *   - `pinnedAt` non-null (Active)  → `doneAt = null`
 *   - `pinnedAt == null` (Done)     → `doneAt = resolvedAt ?? updatedAt ?? createdAt`
 *     (best-effort done-time; sort-safe — Done sort uses `updatedAt`, never this).
 * If `doneAt` is already present (dual-written file), it is authoritative and
 * left untouched — we only delete the stale `pinnedAt`.
 *
 * Idempotent: keyed on whether the `pinnedAt` key is present. Re-running on an
 * already-migrated session (no `pinnedAt` key) is a no-op.
 *
 * Returns true if it mutated the session (so the caller marks it SANITIZED,
 * skipping fingerprint seeding so the rewrite — now WITHOUT `pinnedAt` —
 * persists on the next save).
 */
function migratePinnedToDone(session: AgentSession): boolean {
  const raw = session as unknown as Record<string, unknown>;
  const hasOld = Object.prototype.hasOwnProperty.call(raw, 'pinnedAt');
  if (!hasOld) return false;
  const hasNew = Object.prototype.hasOwnProperty.call(raw, 'doneAt');
  if (!hasNew) {
    // Never-migrated legacy file: derive `doneAt` from `pinnedAt` polarity.
    // Use `== null` (not truthiness): legacy Done is `pinnedAt === null`.
    const legacyPinnedAt = raw['pinnedAt'] as number | null | undefined;
    session.doneAt =
      legacyPinnedAt == null
        ? (session.resolvedAt ?? session.updatedAt ?? session.createdAt)
        : null;
  }
  // CONTRACT: drop the legacy key entirely so it no longer persists.
  delete raw['pinnedAt'];
  return true;
}

/**
 * Backfill `doneAt` for resolved automation sessions that predate the lifecycle
 * model entirely (260617). Automations were never part of the `pinnedAt` model,
 * so the overwhelming majority of automation files carry NO `pinnedAt` key —
 * which means `migratePinnedToDone` (keyed on the presence of `pinnedAt`) is a
 * no-op for them. Their Done state used to live only in the session INDEX
 * (derived once at the index-level INDEX_VERSION 7→8 migration) and was never
 * written back to the files. A rebuild-from-files (e.g. the 260617 index-collapse
 * recovery) therefore reverts every such automation to Active (`doneAt == null`),
 * because `createSummary` reads `doneAt` straight from the file.
 *
 * Fix, scoped to be safe: a session is backfilled to Done ONLY when
 *   - `origin === 'automation'` (auto-resolved by nature; a completed run carries
 *     `resolvedAt`, a running run does not — so this can't mark a live run Done),
 *   - it has NO `doneAt` KEY (not merely `doneAt == null`): a key present with a
 *     null value means the user explicitly REOPENED it — that choice is preserved,
 *   - `resolvedAt` is a real timestamp (the only trustworthy done-time; automations
 *     with no `resolvedAt` stay Active rather than inventing one).
 * Then `doneAt = resolvedAt`, mirroring `migratePinnedToDone`'s Done branch.
 *
 * MUST run AFTER `migratePinnedToDone`: that migration adds a `doneAt` key for any
 * `pinnedAt`-keyed file, so the "no doneAt key" gate here naturally excludes them
 * (no double-handling). Idempotent: once `doneAt` is written the key is present,
 * so re-running is a no-op. Returns true if it mutated the session (so the caller
 * marks it SANITIZED and the rewrite — now WITH `doneAt` — persists on next save).
 */
function migrateResolvedAutomationToDone(session: AgentSession): boolean {
  // eslint-disable-next-line no-restricted-syntax -- origin-classification-justified: legacy persisted-session migration gate intentionally keys off the stored origin field being repaired.
  if (session.origin !== 'automation') return false;
  const raw = session as unknown as Record<string, unknown>;
  // Key-presence gate (not truthiness): an explicit reopen writes `doneAt: null`,
  // which must be left as Active. Only a missing key is an un-migrated legacy file.
  if (Object.prototype.hasOwnProperty.call(raw, 'doneAt')) return false;
  if (session.resolvedAt == null) return false;
  session.doneAt = session.resolvedAt;
  return true;
}

function detectDoubledHalves(text: string): string | null {
  const separator = '\n\n';
  if (text.length < 5) return null;
  const halfLength = (text.length - separator.length) / 2;
  if (!Number.isInteger(halfLength) || halfLength <= 0) return null;
  if (text.slice(halfLength, halfLength + separator.length) !== separator) return null;
  const first = text.slice(0, halfLength);
  const second = text.slice(halfLength + separator.length);
  if (first !== second) return null;
  return first;
}

function repairDoubledResultArtifact(
  session: AgentSession,
): { session: AgentSession; repairedTurnIds: string[]; repairedEventCount: number } | null {
  const eventsByTurn = session.eventsByTurn ?? {};
  if (Object.keys(eventsByTurn).length === 0) return null;

  const newEventsByTurn: Record<string, AgentEvent[]> = {};
  const assistantHalfByTurn = new Map<string, string>();
  const repairedTurnIds: string[] = [];
  let repairedEventCount = 0;
  let eventsChanged = false;

  for (const [turnId, events] of Object.entries(eventsByTurn)) {
    const seenKeys = new Map<string, AgentEvent>();
    const deduped: AgentEvent[] = [];
    let turnHadSeqMismatchDuplicate = false;

    for (const event of events) {
      const key = getContentEquivalenceKey(turnId, event);
      if (key === null) {
        deduped.push(event);
        continue;
      }
      const previous = seenKeys.get(key);
      if (previous) {
        // Content-equivalent duplicate. Repair only when seq differs — that's
        // the restamping fingerprint from the diagnosis doc. Same-seq
        // collisions are excluded so we never repair without evidence.
        if (previous.seq !== event.seq) {
          turnHadSeqMismatchDuplicate = true;
          repairedEventCount += 1;
        } else {
          deduped.push(event);
        }
        continue;
      }
      seenKeys.set(key, event);
      deduped.push(event);
      if (event.type === 'assistant' && !assistantHalfByTurn.has(turnId)) {
        assistantHalfByTurn.set(turnId, event.text);
      }
    }

    if (turnHadSeqMismatchDuplicate) {
      newEventsByTurn[turnId] = deduped;
      repairedTurnIds.push(turnId);
      eventsChanged = true;
    } else {
      newEventsByTurn[turnId] = events;
      assistantHalfByTurn.delete(turnId);
    }
  }

  if (!eventsChanged) return null;

  let messagesChanged = false;
  const newMessages = (session.messages ?? []).map((msg) => {
    if (msg.role !== 'result') return msg;
    const halfCandidate = assistantHalfByTurn.get(msg.turnId);
    if (!halfCandidate) return msg;
    const detected = detectDoubledHalves(msg.text);
    if (detected === null) return msg;
    if (detected !== halfCandidate) return msg;
    messagesChanged = true;
    return { ...msg, text: detected };
  });

  return {
    session: {
      ...session,
      eventsByTurn: newEventsByTurn,
      ...(messagesChanged ? { messages: newMessages } : {}),
    },
    repairedTurnIds,
    repairedEventCount,
  };
}

/**
 * Collapse whole-duplicate `result` messages — two or more `result`-role
 * messages for the SAME turn with byte-identical text — corroborated by a
 * DOUBLED `turn_started` for that turn. A turn yields exactly one final result
 * message, so an identical-text repeat under a doubled turn-start is a
 * double-materialization artifact, not content (260618 diagnosis: a turn with
 * two `turn_started` events had persisted two identical result messages with
 * distinct ids, which the renderer showed as two duplicate "Done…" cards).
 *
 * Sibling of `repairDoubledResultArtifact`: that pass collapses restamped
 * duplicate EVENTS and un-doubles within-message text; this one removes
 * duplicate message OBJECTS in `session.messages` that neither it (it early-
 * returns when no event changed) nor the id-keyed `deduplicateMessages`
 * removes — the duplicates carry DISTINCT ids.
 *
 * Evidence-gated to be false-positive-proof, mirroring the parent pass's
 * "never repair without evidence" philosophy: requires (a) same turnId, (b)
 * byte-identical text, AND (c) a doubled `turn_started` on that turn. The
 * `turn_started` pair is a reliable signal because that event type has no
 * content-equivalence key, so it survives the event-dedup pass untouched.
 * Keeps the FIRST occurrence. Returns null when nothing changed.
 */
function dedupeDoubledResultMessages(
  session: AgentSession,
): { session: AgentSession; removedMessageIds: string[]; repairedTurnIds: string[] } | null {
  const messages = session.messages ?? [];
  if (messages.length === 0) return null;

  // Corroboration: turns that emitted more than one `turn_started`.
  const doubledStartTurns = new Set<string>();
  for (const [turnId, events] of Object.entries(session.eventsByTurn ?? {})) {
    let startCount = 0;
    for (const event of events) {
      if (event.type === 'turn_started') {
        startCount += 1;
        if (startCount > 1) {
          doubledStartTurns.add(turnId);
          break;
        }
      }
    }
  }
  if (doubledStartTurns.size === 0) return null;

  const seen = new Set<string>();
  const removedMessageIds: string[] = [];
  const repairedTurnIds = new Set<string>();
  const kept = messages.filter((message) => {
    if (message.role !== 'result' || !doubledStartTurns.has(message.turnId)) return true;
    const key = JSON.stringify([message.turnId, message.text]);
    if (seen.has(key)) {
      removedMessageIds.push(message.id);
      repairedTurnIds.add(message.turnId);
      return false;
    }
    seen.add(key);
    return true;
  });

  if (removedMessageIds.length === 0) return null;
  return {
    session: { ...session, messages: kept },
    removedMessageIds,
    repairedTurnIds: [...repairedTurnIds],
  };
}

function normalizeSessionTurnState(session: AgentSession): AgentSession {
  // Strip ghost fields from sessions persisted before their removal.
  // Raw JSON.parse preserves unknown keys; this is the single load-path choke point.
  // Safe to remove this block once all user session files have cycled through a save.
  delete (session as unknown as Record<string, unknown>)['upstreamSessionId'];
  delete (session as unknown as Record<string, unknown>)['terminatedTurnIds'];

  // Load-boundary hardening: guarantee `messages` is an array and `eventsByTurn`
  // is a well-formed object-of-arrays before ANY downstream reader touches them
  // (countUserMessages, projection, fingerprint, aggregateSessionUsage,
  // getMaxSeqFromSession, deriveTurnLiveness). Must run before
  // backfillModelUsageProvidersSeen / getMaxSeqFromSession below, which iterate
  // eventsByTurn.
  const messagesCoerced = coerceMessagesArray(session);
  const eventsByTurnCoerced = coerceEventsByTurn(session);

  backfillModelUsageProvidersSeen(session);

  // EXPAND step of the pinnedAt → doneAt rename: dual-write `doneAt` from
  // legacy `pinnedAt` on hydration. See docs/plans/260614_done-state-rename/PLAN.md.
  const pinnedToDoneMigrated = migratePinnedToDone(session);

  // Backfill `doneAt` for resolved automations born without a `pinnedAt` key
  // (260617). MUST run after migratePinnedToDone (see that fn's doc).
  const resolvedAutomationMigrated = migrateResolvedAutomationToDone(session);

  // Hydrate per-session seq tracking from persisted events at load time so
  // new runtime events continue the monotonic session sequence even for
  // pre-refinement sessions that were restored from disk.
  getSessionSeqIndex().setSeqFromStorage(session.id, getMaxSeqFromSession(session));

  const orphanStatusEntriesRemoved = cleanupOrphanStatusEntries(session);
  if (orphanStatusEntriesRemoved > 0) {
    log.info(
      { sessionId: session.id, removedCount: orphanStatusEntriesRemoved },
      'Removed orphan status entries with mismatched session provenance on hydration',
    );
  }

  const doubledResultRepair = repairDoubledResultArtifact(session);
  if (doubledResultRepair) {
    session = doubledResultRepair.session;
    const TURN_ID_SAMPLE_LIMIT = 10;
    log.info(
      {
        sessionId: session.id,
        turnId: doubledResultRepair.repairedTurnIds[0] ?? null,
        repairedTurnIds: doubledResultRepair.repairedTurnIds.slice(
          0,
          TURN_ID_SAMPLE_LIMIT,
        ),
        repairedTurnCount: doubledResultRepair.repairedTurnIds.length,
        repairedTurnIdsTruncated:
          doubledResultRepair.repairedTurnIds.length > TURN_ID_SAMPLE_LIMIT,
        repairedEventCount: doubledResultRepair.repairedEventCount,
      },
      'session-doubled-result-repair',
    );
  }
  const doubledResultMutated = doubledResultRepair !== null;

  // Collapse whole-duplicate result MESSAGES (distinct ids, same turn,
  // identical text) corroborated by a doubled turn_started — a sibling repair
  // to the event-level pass above (260618 diagnosis).
  const resultMessageDedupe = dedupeDoubledResultMessages(session);
  if (resultMessageDedupe) {
    session = resultMessageDedupe.session;
    log.info(
      {
        sessionId: session.id,
        repairedTurnIds: resultMessageDedupe.repairedTurnIds.slice(0, 10),
        removedMessageCount: resultMessageDedupe.removedMessageIds.length,
      },
      'session-doubled-result-message-dedupe',
    );
  }
  const resultMessageDedupeMutated = resultMessageDedupe !== null;

  const markIfHydrationMutated = (normalized: AgentSession): AgentSession => {
    if (orphanStatusEntriesRemoved > 0 || doubledResultMutated || resultMessageDedupeMutated || pinnedToDoneMigrated || resolvedAutomationMigrated || messagesCoerced || eventsByTurnCoerced) {
      SANITIZED_SESSIONS.add(normalized);
    }
    return normalized;
  };

  // Handle inconsistent state: isBusy=true but activeTurnId=null
  // This can happen if persistence snapshots mid-update
  if (session.isBusy && !session.activeTurnId) {
    log.debug(
      { sessionId: session.id },
      'Normalizing inconsistent state - isBusy=true but no activeTurnId'
    );
    return markIfHydrationMutated(sanitizeOrphanRunningMemoryUpdateStatuses({ ...session, isBusy: false }));
  }

  // No active turn claimed - nothing to normalize
  if (!session.activeTurnId) {
    return markIfHydrationMutated(sanitizeOrphanRunningMemoryUpdateStatuses(session));
  }

  // Check if the claimed active turn has a terminal event
  if (hasTerminalEventInTurn(session.eventsByTurn, session.activeTurnId)) {
    // Turn completed but state fields weren't updated (race condition)
    // Return corrected state
    log.debug(
      { sessionId: session.id, turnId: session.activeTurnId },
      'Normalizing stale isBusy state - turn has terminal event'
    );
    return markIfHydrationMutated(sanitizeOrphanRunningMemoryUpdateStatuses({
      ...session,
      activeTurnId: null,
      isBusy: false,
    }));
  }

  // No terminal event - turn may actually be in progress or was interrupted
  // Don't change state here; let the UI handle interrupted turns
  return markIfHydrationMutated(sanitizeOrphanRunningMemoryUpdateStatuses(session));
}

/**
 * THE on-disk session hydration boundary.
 *
 * `JSON.parse(content) as AgentSession` trusts the persisted shape and bypasses
 * Zod defaults, so a malformed/partial-write file can carry a non-array
 * `messages` / `eventsByTurn`. A reader that then does `messages.filter(...)`
 * (e.g. `countUserMessages` inside `createSummary`) throws — the
 * 260616 index-collapse class. Routing every session load through one helper
 * makes "an absent/non-array field reaches a reader" impossible-by-construction
 * instead of guarded reader-by-reader. Enforced by
 * `scripts/check-session-hydration-boundary.ts` (validate:fast): raw
 * `JSON.parse(...) as AgentSession` is banned outside these two helpers.
 *
 * Two tiers:
 * - `hydrateSession` — full hydration (`normalizeSessionTurnState`: array
 *   coercion + ghost-field strip + doneAt migration + seq backfill + orphan/
 *   doubled-result repair + isBusy/activeTurnId normalization). Use when loading
 *   a session **for use** (read, project, summarize).
 * - `hydrateSessionArraysOnly` — parse + array coercion ONLY, no side effects.
 *   Use on paths that apply their **own** distinct turn-state correction
 *   (startup/shutdown interruption handling) and must not have it pre-empted by
 *   the full normalize, but still need array safety before `createSummary`.
 */
function hydrateSession(content: string): AgentSession {
  // hydration-exempt: THE full-hydration boundary (see the doc block above).
  return normalizeSessionTurnState(JSON.parse(content) as AgentSession);
}

/**
 * Parse + array-coercion only (no `normalizeSessionTurnState` side effects). See
 * `hydrateSession` for why this second tier exists (turn-correction paths).
 *
 * Exported so other surfaces that load raw session files (e.g. the diagnostics
 * log-export in `logExportService`) hydrate through the same boundary rather than
 * re-introducing a bare `JSON.parse(...) as AgentSession`.
 */
export function hydrateSessionArraysOnly(content: string): AgentSession {
  // hydration-exempt: THE arrays-only hydration boundary (see the doc block above).
  const session = JSON.parse(content) as AgentSession;
  coerceMessagesArray(session);
  coerceEventsByTurn(session);
  return session;
}

/**
 * Remove status-map entries whose recorded provenance does not match this
 * session ID. These are provably misrouted pre-v2 entries.
 *
 * Legacy entries missing `originalSessionId` are preserved for backward
 * compatibility and logged once per session per process.
 */
function cleanupOrphanStatusEntries(session: AgentSession): number {
  let removedCount = 0;
  let legacyMemoryEntries = 0;
  let legacyTimeSavedEntries = 0;

  const memoryStatuses = session.memoryUpdateStatusByTurn;
  if (memoryStatuses) {
    let cleanedMemoryStatuses: Record<string, MemoryUpdateStatus> | null = null;

    for (const [turnId, status] of Object.entries(memoryStatuses)) {
      if (!status.originalSessionId) {
        legacyMemoryEntries += 1;
        continue;
      }
      if (status.originalSessionId === session.id) {
        continue;
      }
      cleanedMemoryStatuses ??= { ...memoryStatuses };
      delete cleanedMemoryStatuses[turnId];
      removedCount += 1;
    }

    if (cleanedMemoryStatuses) {
      session.memoryUpdateStatusByTurn = cleanedMemoryStatuses;
    }
  }

  const timeSavedStatuses = session.timeSavedStatusByTurn;
  if (timeSavedStatuses) {
    let cleanedTimeSavedStatuses: Record<string, TimeSavedStatus> | null = null;

    for (const [turnId, status] of Object.entries(timeSavedStatuses)) {
      if (!status.originalSessionId) {
        legacyTimeSavedEntries += 1;
        continue;
      }
      if (status.originalSessionId === session.id) {
        continue;
      }
      cleanedTimeSavedStatuses ??= { ...timeSavedStatuses };
      delete cleanedTimeSavedStatuses[turnId];
      removedCount += 1;
    }

    if (cleanedTimeSavedStatuses) {
      session.timeSavedStatusByTurn = cleanedTimeSavedStatuses;
    }
  }

  if (legacyMemoryEntries > 0) {
    LEGACY_MEMORY_STATUS_SESSION_IDS.add(session.id);
  }
  if (legacyTimeSavedEntries > 0) {
    LEGACY_TIME_SAVED_STATUS_SESSION_IDS.add(session.id);
  }

  if ((legacyMemoryEntries > 0 || legacyTimeSavedEntries > 0) && !legacyStatusFirstDetectionLogged) {
    legacyStatusFirstDetectionLogged = true;
    log.info(
      {
        sessionsWithLegacyMemoryEntries: LEGACY_MEMORY_STATUS_SESSION_IDS.size,
        sessionsWithLegacyTimeSavedEntries: LEGACY_TIME_SAVED_STATUS_SESSION_IDS.size,
      },
      'First detection of legacy status entries missing originalSessionId; counts are sessions seen so far this process',
    );
  }

  if (
    (legacyMemoryEntries > 0 || legacyTimeSavedEntries > 0)
    && !LEGACY_STATUS_LOGGED_SESSION_IDS.has(session.id)
  ) {
    LEGACY_STATUS_LOGGED_SESSION_IDS.add(session.id);
    if (legacyMemoryEntries > 0 && legacyTimeSavedEntries > 0) {
      log.debug(
        { sessionId: session.id, legacyMemoryEntries, legacyTimeSavedEntries },
        'Preserving legacy memory-update and time-saved status entries missing originalSessionId',
      );
    } else if (legacyMemoryEntries > 0) {
      log.debug(
        { sessionId: session.id, legacyEntries: legacyMemoryEntries },
        'Preserving legacy memory-update status entries missing originalSessionId',
      );
    } else {
      log.debug(
        { sessionId: session.id, legacyEntries: legacyTimeSavedEntries },
        'Preserving legacy time-saved status entries missing originalSessionId',
      );
    }
  }

  return removedCount;
}

function sanitizeOrphanRunningMemoryUpdateStatuses(session: AgentSession): AgentSession {
  const statuses = session.memoryUpdateStatusByTurn;
  if (!statuses) return session;

  let sanitizedStatuses: Record<string, MemoryUpdateStatus> | null = null;
  let sanitizedCount = 0;
  const now = Date.now();

  for (const [turnId, status] of Object.entries(statuses)) {
    if (status.status !== 'running') continue;
    // Preserve recently-broadcast running statuses: a BTS memory-update turn
    // may legitimately still be in flight. Only entries older than the grace
    // window are treated as orphans from a previous app run.
    if (now - status.timestamp < ORPHAN_RUNNING_GRACE_MS) continue;

    sanitizedStatuses ??= { ...statuses };
    sanitizedStatuses[turnId] = {
      status: 'error',
      error: ORPHAN_MEMORY_UPDATE_ERROR,
      originalTurnId: status.originalTurnId,
      timestamp: now,
    };
    sanitizedCount += 1;
  }

  if (!sanitizedStatuses) return session;

  log.debug(
    { sessionId: session.id, sanitizedCount },
    'Sanitized orphan running memory-update statuses on hydration'
  );

  const corrected: AgentSession = {
    ...session,
    memoryUpdateStatusByTurn: sanitizedStatuses,
  };
  // Mark the corrected object so the load path can skip cache seeding,
  // forcing the next save to persist the repair to disk.
  SANITIZED_SESSIONS.add(corrected);
  return corrected;
}
const LEGACY_FILENAME = 'agent-session-history.json';
const SESSIONS_DIR = 'sessions';
const INDEX_FILENAME = 'index.json';
// Rolling backup of index.json, refreshed (validate-first) BEFORE each primary
// index overwrite by writeIndexFileAtomic[Sync]. On a corrupt primary, load and
// reload-upsert recover the full corpus from this copy before any
// rebuild-from-files. NOTE: it does not end in `.json`, so `isSessionFile()`
// already excludes it from every session scan by suffix.
const INDEX_BACKUP_FILENAME = 'index.json.bak';
const DELETED_SESSIONS_DIR = 'sessions-deleted';
const AGENT_SESSIONS_DIR = 'agent-sessions'; // Orphaned dir from partial SessionStorageService impl

/**
 * DISK WRITE-GUARD LEDGER (hard-delete tombstones) — Stage 3 of
 * docs/plans/260612_recs-round5/PLAN.md.
 *
 * Lives INSIDE `sessions/` (rev-2, ruling 7) so the `.rebeltransfer` migration
 * classification (`relPaths: ['sessions']`) carries tombstones across machines.
 * Listed in NON_SESSION_FILES (here) and its mirror SESSION_DIR_NON_PAYLOAD_FILES
 * (migrationImportService.ts) — keep the two in lockstep.
 *
 * NAMING NOTE (rev-2, RS F16): this is the *disk write-guard* ledger — do NOT
 * conflate it with `getSessionTombstoneStore()`
 * (src/core/services/continuity/sessionTombstoneStore.ts), which owns CLOUD
 * SYNC tombstone semantics (cross-device delete propagation, catch-up
 * responses). Authority split: sync semantics → SessionTombstoneStore; local
 * disk write-drop protection → this ledger. Both exist on purpose.
 */
const SESSION_DELETE_LEDGER_FILENAME = 'session-delete-ledger.json';
const SESSION_DELETE_LEDGER_VERSION = 1;

/**
 * Files that the migrateFromLegacy partial-migration guard RE-PLACES into the
 * fresh `sessions/` directory after renaming the old one to the timestamped
 * backup. Everything else stays only in the backup (recoverable, not live).
 *
 * Stage 3 (260612 recs-round5 PLAN, RS F18): the hard-delete ledger MUST be
 * re-placed — a partial-migration retry must not re-materialize legacy sessions
 * against an empty ledger (silent tombstone-protection loss).
 */
const PARTIAL_MIGRATION_PRESERVED_FILES: readonly string[] = [
  SESSION_DELETE_LEDGER_FILENAME,
];

/**
 * Non-session JSON files that live in the sessions/ directory.
 * Cloud metadata services store their state here alongside session files.
 * Must be excluded when scanning for session files (rebuild, orphan detection, crash recovery).
 * (INDEX_BACKUP_FILENAME is excluded by suffix — it does not end in `.json`.)
 *
 * MUST stay in lockstep with `SESSION_DIR_NON_PAYLOAD_FILES` in
 * migrationImportService.ts — a missing entry here is the DANGEROUS direction: a
 * sidecar that ends in `.json` is treated as a session, hydrates into an
 * `id`-less "session", and poisons the index with a summary whose `id` is
 * undefined, which then crashed `classifySessionKind(undefined)` across
 * sessions:list / time-saved / every turn (this is exactly how
 * `cloud-tombstone-quarantine.json` was missed). Enforced by
 * `sessionSidecarDenylist.lockstep.test.ts`. Exported for that test.
 * See docs-private/investigations/260617_classifysessionkind_undefined_crash_handoff.md.
 */
export const NON_SESSION_FILES = new Set([
  INDEX_FILENAME,
  SESSION_DELETE_LEDGER_FILENAME,
  'cloud-outbox.json',
  'cloud-continuity-meta.json',
  'cloud-sync-meta.json',
  'cloud-workspace-manifest.json',
  'cloud-tombstone-quarantine.json',
  'folders.json',
]);

/** Check whether a filename in sessions/ is an actual session file. */
function isSessionFile(filename: string): boolean {
  return filename.endsWith('.json') && !NON_SESSION_FILES.has(filename);
}


/**
 * Index entry extends AgentSessionSummary with fingerprint for dirty tracking.
 * This ensures IPC handlers return the correct shape.
 */
type SessionIndexEntry = AgentSessionSummary & { fingerprint: string };

interface SessionIndex {
  version: number;
  lastUpdated: number;
  sessions: SessionIndexEntry[];
}

interface LegacySessionHistoryData {
  version: number;
  sessions: AgentSession[];
}

/**
 * Discriminated result of the shared 4-way index validation (Stage 2 item 2,
 * FMM C-7). Version mismatch is NEVER conflated with corruption:
 *  - 'ok'               — current version, every entry usable; adopt as-is.
 *  - 'version-forward'  — written by a NEWER app; route to the EXISTING
 *                         forward-version handling (read-only protection).
 *  - 'version-backward' — older format needing migration; route to the
 *                         EXISTING rebuild/migration handling (and reload-
 *                         upserts write through, preserving today's CLI
 *                         behavior — the round-6 GPT edge).
 *  - 'corrupt'          — garbage/unusable bytes; ONLY this leg may enter
 *                         backup recovery.
 */
type IndexValidationResult =
  | { status: 'ok'; index: SessionIndex }
  | { status: 'version-forward'; index: SessionIndex }
  | { status: 'version-backward'; index: SessionIndex }
  | { status: 'corrupt' };

/**
 * Result of a raw index-file read that DISTINGUISHES a transient IO failure
 * (EMFILE/ENFILE under fd pressure, or any non-ENOENT read error on a file that
 * exists) from absence and from genuine corruption (REBEL-1C8 class).
 *
 *  - 'read'      — bytes obtained; hand to {@link parseAndValidateIndex}.
 *  - 'absent'    — ENOENT: file does not exist (fresh start / no prior index).
 *  - 'transient' — the file EXISTS but couldn't be read this time (EMFILE/ENFILE
 *                  survived the single sync retry, or another non-ENOENT IO
 *                  error). This is NOT corruption: the on-disk index may be
 *                  perfectly good. Callers MUST degrade safely (keep the
 *                  in-memory index / skip this attempt) and MUST NOT trigger
 *                  `.bak` recovery or rebuild-from-files, which would destroy or
 *                  needlessly rebuild a healthy index.
 *
 * Why this matters: the always-on startup time-saved repair scans the whole
 * corpus, and `fs.readFileSync(index.json)` cannot be reached by graceful-fs's
 * EMFILE queue (it patches only callback APIs). An EMFILE here used to throw and
 * be caught as "index corrupted" → `.bak` recovery → rebuild — a transient,
 * byte-identical "corruption" loop.
 */
type IndexReadResult =
  | { kind: 'read'; content: string }
  | { kind: 'absent' }
  | { kind: 'transient'; error: unknown };

/**
 * Sentinel thrown by `loadFromNewFormat[Sync]` / `loadIndexOnlySync` when the
 * index file could not be read TRANSIENTLY (see {@link IndexReadResult}). The
 * `load[Sync]()` / `listSessions()` catch sites recognise this type and degrade
 * (keep the existing in-memory index, return `[]`) WITHOUT routing to `.bak`
 * recovery or rebuild-from-files — those are reserved for GENUINE corruption.
 */
class TransientIndexReadError extends Error {
  constructor(public readonly cause: unknown) {
    super('Transient failure reading session index.json (not corruption)');
    this.name = 'TransientIndexReadError';
  }
}

function isTransientIndexReadError(error: unknown): error is TransientIndexReadError {
  return error instanceof TransientIndexReadError;
}

/**
 * Outcome of a synchronous batch upsert (Stage 2 item 4b; Stage 3 per-session
 * drop reporting). A dropped write must be VISIBLE to callers: `sessions:upsert`
 * returns failure to the renderer instead of `{success:true}` and skips
 * embedding/cloud hooks for a write that never landed.
 *
 * Stage 3 (260612 recs-round5): partial batches fire `onSessionsSaved` /
 * `onSessionsSavedLocally` ONLY for persisted sessions — `persisted` carries
 * the per-session split, and a batch whose every member was tombstone-dropped
 * gets its own variant so single-session callers can surface it.
 */
export type SessionsSyncUpsertOutcome =
  | {
      outcome: 'persisted';
      /** Ids actually written to disk this batch. */
      persistedSessionIds: string[];
      /** Ids dropped because they are hard-delete tombstoned (delete-wins). */
      droppedTombstonedSessionIds: string[];
    }
  | { outcome: 'noop-empty-batch' }
  | {
      outcome: 'all-dropped-tombstoned';
      droppedTombstonedSessionIds: string[];
    }
  | {
      outcome: 'dropped';
      reason:
        | 'read-only'
        | 'corrupt-index-unrecoverable'
        | 'version-forward-index'
        | 'transient-index-read';
    };

/**
 * Required delete-intent discriminator (Stage 3, rev-2 ruling 2): a caller
 * cannot hard-delete without declaring intent (delete-authority pattern).
 *
 *  - 'user-delete' — genuine deletion intent (user action, cross-device
 *    delete-wins, E2E factory reset). Writes the durable disk write-guard
 *    ledger: the id can never be recreated on disk by stale writes.
 *  - 'hygiene'     — housekeeping/GC (leaked-session cleanup, ghost-prune,
 *    continuity GC). Prunes file+index exactly as before but NEVER writes the
 *    ledger: tombstoning presumed-gone or regenerated data would permanently
 *    block a legitimate later write or cloud re-sync (the eviction trap
 *    through a caller — DEFERRAL §3 #1's shape).
 *
 * Classification is by CALL SITE, never by id shape/prefix. The caller
 * enumeration harness (sessionDeleteCallers.harness.test.ts) fails CI on any
 * unclassified caller.
 */
export type SessionDeleteIntent = 'user-delete' | 'hygiene';

export interface SessionDeleteOptions {
  intent: SessionDeleteIntent;
}

/**
 * Outcome of a single-session upsert attempt inside the write queue (Stage 3).
 * Exported (merge graft, 260612 delete-wins collision): cloudRouter/cloudOutbox
 * only advance push/broadcast side effects when the local write actually
 * landed — they consume this via {@link IncrementalSessionStore.upsertSessionWithOutcome}.
 */
export type SessionSingleUpsertOutcome =
  | 'persisted'
  | 'dropped-tombstoned'
  | 'dropped-read-only'
  /**
   * The on-disk index could not be safely reloaded before this write because
   * index.json was present but TRANSIENTLY unreadable (EMFILE/IO). The session
   * FILE was written (so the data is not lost — orphan-recovery / next full load
   * picks it up), but the INDEX write was DEFERRED rather than overwriting the
   * intact on-disk index with a shrunken one. Consumers treat this like any
   * other non-'persisted' outcome (no success side effects).
   */
  | 'dropped-transient-index';

interface SessionDeleteLedgerEntry {
  deletedAt: number;
}

interface SessionDeleteLedger {
  version: number;
  hardDeletedSessions: Record<string, SessionDeleteLedgerEntry>;
}

/**
 * Source labels for tombstoned-write drops (telemetry). Labels name the ACTUAL
 * guarding method (rev-2, RS F13 — the mined port mislabeled the migration
 * write-skips and the read chokepoints as `doUpsertSession`/`loadFromNewFormat`).
 */
type SessionWriteGuardSource =
  | 'saveSync'
  | 'flush'
  | 'upsertSessionsSyncInternal'
  | 'doUpsertSession'
  | 'writeIndex'
  | 'writeIndexSync'
  | 'loadFromNewFormat'
  | 'loadFromNewFormatSync'
  | 'loadSessionFileStrict'
  | 'loadSessionFileSync'
  | 'rebuildIndexFromFiles'
  | 'rebuildIndexFromFilesSync'
  | 'loadIndexOnlySync'
  | 'refreshSessionIndexSummaries'
  | 'migrateFromLegacy'
  | 'migrateFromLegacySync'
  | 'migrateFromAgentSessions'
  | 'migrateFromAgentSessionsSync'
  | 'correctInterruptedSessionsOnStartup'
  | 'finalizeActiveSessionsOnShutdown';

interface SessionDeleteGuardCounters {
  rejectedWritesBySource: Record<string, number>;
  /** Ledger persist failures during delete (delete still succeeds — item d). */
  ledgerWriteFailures: number;
  /** Transient (non-ENOENT) ledger read failures — consult retried next time. */
  ledgerTransientLoadFailures: number;
  /** Corrupt/unparseable ledger content observed (fail-open: empty set). */
  ledgerCorruptLoads: number;
  firstRejectedAt: number | null;
  lastRejectedAt: number | null;
}

const hardDeleteGuardCounters: SessionDeleteGuardCounters = {
  rejectedWritesBySource: {},
  ledgerWriteFailures: 0,
  ledgerTransientLoadFailures: 0,
  ledgerCorruptLoads: 0,
  firstRejectedAt: null,
  lastRejectedAt: null,
};

/**
 * MUTATION SEAM (reviewers only — never ship `false`): flipping this constant
 * disables every ledger consult, which must turn the resurrection suite
 * (incrementalSessionStore.deleteTombstones.test.ts) red. It exists so a
 * reviewer can verify those tests are load-bearing on the consult itself
 * rather than on incidental file-system effects.
 */
const HARD_DELETE_LEDGER_CONSULT_ENABLED: boolean = true;

export class IncrementalSessionStore {
  private readonly userDataPath: string;
  private readonly sessionsDir: string;
  private readonly indexPath: string;
  private readonly indexBackupPath: string;
  private readonly legacyPath: string;
  private readonly agentSessionsDir: string;
  private readonly deletedSessionsDir: string;
  private readonly deleteLedgerPath: string;

  private cachedFingerprints: Map<string, string> = new Map();
  private writeQueue: Promise<void> = Promise.resolve();
  private isWriting = false;
  private pendingSessions: AgentSession[] | null = null;

  /**
   * In-memory hard-delete tombstone set (disk write-guard ledger).
   *
   * UNION-only by construction (rev-2, C-17): this set is NEVER replaced —
   * disk reads union INTO it, and in-memory adds (e.g. from a delete whose
   * ledger persist failed) are never dropped by a later disk read.
   */
  private readonly hardDeletedSessionIds = new Set<string>();
  /**
   * Whether the on-disk ledger has been successfully read (or confirmed
   * absent) at least once. Stays false on transient read errors (EMFILE/
   * EACCES) so the next consult retries instead of silently disabling
   * protection for the whole process lifetime (rev-2, RS F9).
   */
  private hardDeleteLedgerDiskLoaded = false;

  /** In-memory index for listSessions() - kept synchronized with disk */
  private index: SessionIndex | null = null;

  constructor() {
    this.userDataPath = getDataPath();
    this.sessionsDir = path.join(this.userDataPath, SESSIONS_DIR);
    this.indexPath = path.join(this.sessionsDir, INDEX_FILENAME);
    this.indexBackupPath = path.join(this.sessionsDir, INDEX_BACKUP_FILENAME);
    this.legacyPath = path.join(this.userDataPath, LEGACY_FILENAME);
    this.agentSessionsDir = path.join(this.userDataPath, AGENT_SESSIONS_DIR);
    this.deletedSessionsDir = path.join(this.userDataPath, DELETED_SESSIONS_DIR);
    this.deleteLedgerPath = path.join(this.sessionsDir, SESSION_DELETE_LEDGER_FILENAME);
  }

  // ===========================================================================
  // Stage 3: Disk write-guard ledger (hard-delete tombstones)
  // See the SESSION_DELETE_LEDGER_FILENAME doc block for the naming/authority
  // split vs the cloud-sync SessionTombstoneStore.
  // ===========================================================================

  /**
   * Read the on-disk ledger and UNION its ids into the in-memory set.
   *
   * Failure posture (Stage 3, EXPLICITLY no degraded mode — DEFERRAL §6(B)):
   *  - ENOENT          → normal (no hard-deletes yet); mark loaded.
   *  - corrupt content → fail-open: behave like today (no protection from the
   *    disk entries), log.error loudly, mark loaded (deterministic bytes —
   *    re-reading cannot help; the next successful ledger persist self-heals
   *    the file). NO "index-absent ⇒ deleted" inference anywhere, NO ledger
   *    `.bak`.
   *  - transient error (EMFILE/EACCES/…) → log + return WITHOUT marking
   *    loaded, so the next consult retries (rev-2, RS F9). Still fail-open
   *    per-consult.
   */
  private readHardDeleteLedgerFromDiskUnion(): void {
    let content: string;
    try {
      content = fs.readFileSync(this.deleteLedgerPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        ignoreBestEffortCleanup(err, {
          operation: 'readHardDeleteLedgerFromDiskUnion.readLedger',
          reason: 'no ledger file yet (normal until the first hard delete)',
        });
        this.hardDeleteLedgerDiskLoaded = true;
        return;
      }
      hardDeleteGuardCounters.ledgerTransientLoadFailures += 1;
      // Observable, intentional fail-open (RS F9): logged loudly + counted,
      // NOT cached — the next consult retries the disk read.
      log.error(
        {
          err: getErrorMessage(err),
          transientLoadFailures: hardDeleteGuardCounters.ledgerTransientLoadFailures,
        },
        'Failed to read hard-delete session ledger (transient) — protection degrades to in-memory set for this consult; will retry',
      );
      ignoreBestEffortCleanup(err, {
        operation: 'readHardDeleteLedgerFromDiskUnion.readLedger',
        reason: 'transient ledger read failure — fail-open per Stage 3 spec, retried on next consult (logged + counted above)',
      });
      return;
    }

    try {
      const ledger = JSON.parse(content) as Partial<SessionDeleteLedger>;
      const entries = ledger.hardDeletedSessions;
      if (!entries || typeof entries !== 'object') {
        throw new Error('ledger missing hardDeletedSessions object');
      }
      for (const sessionId of Object.keys(entries)) {
        if (this.isValidSessionId(sessionId)) {
          this.hardDeletedSessionIds.add(sessionId);
        }
      }
    } catch (err) {
      hardDeleteGuardCounters.ledgerCorruptLoads += 1;
      log.error(
        {
          err: getErrorMessage(err),
          corruptLoads: hardDeleteGuardCounters.ledgerCorruptLoads,
        },
        'Hard-delete session ledger is corrupt — FAIL-OPEN to today\'s behavior (no disk tombstone protection until the next successful delete rewrites it)',
      );
    }
    this.hardDeleteLedgerDiskLoaded = true;
  }

  /** Lazy consult-path load: read disk once (retrying after transient errors). */
  private ensureHardDeleteLedgerLoaded(): Set<string> {
    if (!this.hardDeleteLedgerDiskLoaded) {
      this.readHardDeleteLedgerFromDiskUnion();
    }
    return this.hardDeletedSessionIds;
  }

  /**
   * Forced re-read for the cross-process reload-upsert path (rev-2, C-17):
   * called at the TOP of `upsertSessionsSyncInternal` when `forceReloadIndex`
   * is set — BEFORE `filterWritableSessions` runs on the incoming batch and
   * INSIDE the same lock window as the index re-read — so another process's
   * fresh hard-delete is honored. UNIONs disk contents into the in-memory set;
   * never replaces it (a replace would drop in-memory-only entries from a
   * failed ledger persist).
   */
  private reloadHardDeleteLedgerForCrossProcessUpsert(): void {
    this.readHardDeleteLedgerFromDiskUnion();
  }

  private isHardDeletedSessionId(sessionId: string): boolean {
    if (!HARD_DELETE_LEDGER_CONSULT_ENABLED) return false;
    return this.ensureHardDeleteLedgerLoaded().has(sessionId);
  }

  /**
   * Read full ledger entries (id → deletedAt) for a read-merge-write update,
   * merging the in-memory set (UNION — in-memory-only ids from a previously
   * failed persist are re-attempted, never dropped).
   */
  private readHardDeleteLedgerEntries(): Map<string, number> {
    const entries = new Map<string, number>();
    try {
      const content = fs.readFileSync(this.deleteLedgerPath, 'utf8');
      const ledger = JSON.parse(content) as Partial<SessionDeleteLedger>;
      const hardDeletedSessions = ledger.hardDeletedSessions;
      if (hardDeletedSessions && typeof hardDeletedSessions === 'object') {
        for (const [sessionId, entry] of Object.entries(hardDeletedSessions)) {
          if (!this.isValidSessionId(sessionId)) continue;
          const deletedAt =
            typeof entry?.deletedAt === 'number' && Number.isFinite(entry.deletedAt)
              ? entry.deletedAt
              : Date.now();
          entries.set(sessionId, deletedAt);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.error(
          { err: getErrorMessage(err) },
          'Failed to read hard-delete session ledger before update — rewriting from the in-memory set',
        );
      }
    }
    for (const sessionId of this.hardDeletedSessionIds) {
      if (!entries.has(sessionId)) {
        entries.set(sessionId, Date.now());
      }
    }
    return entries;
  }

  private createHardDeleteLedger(deletedAtBySessionId: Map<string, number>): SessionDeleteLedger {
    const hardDeletedSessions: Record<string, SessionDeleteLedgerEntry> = {};
    for (const [sessionId, deletedAt] of deletedAtBySessionId) {
      hardDeletedSessions[sessionId] = { deletedAt };
    }
    return {
      version: SESSION_DELETE_LEDGER_VERSION,
      hardDeletedSessions,
    };
  }

  /**
   * Record a hard-deleted id: in-memory FIRST (in-process protection holds
   * even if the persist below fails), then atomic read-merge-write of the
   * durable ledger file.
   *
   * SINGLE-WRITER ASSUMPTION (rev-2, RS F11): the ledger file is
   * single-writer-per-profile by current reality — only desktop main /
   * cloud-service ever delete (the CLI never deletes), and both route through
   * this store's write queue. There is deliberately NO cross-process delete
   * lock (rev-2, RS F10): `doDeleteSession` participates in no lock today and
   * this stage does not add one — the delete-vs-CLI-locked-upsert race window
   * is the CLI's whole critical section, its outcome is benign, and it
   * self-heals at the next load via the read-chokepoint quarantine (accepted
   * residual). The caller-enumeration harness keeps the single-writer
   * assumption true.
   */
  private async recordHardDeletedSessionId(
    sessionId: string,
    deletedAt: number = Date.now(),
  ): Promise<void> {
    this.ensureHardDeleteLedgerLoaded();
    this.hardDeletedSessionIds.add(sessionId);

    const entries = this.readHardDeleteLedgerEntries();
    entries.set(sessionId, deletedAt);

    await fs.promises.mkdir(this.sessionsDir, { recursive: true });
    await writeFile(this.deleteLedgerPath, JSON.stringify(this.createHardDeleteLedger(entries)), 'utf8');
  }

  /**
   * Factory-reset semantics for E2E test isolation ONLY (Stage 3, rev-2
   * ruling 3): clears the on-disk ledger AND the in-memory set so reseeding
   * previously-deleted fixture ids (e.g. DEFAULT_E2E_SESSION_ID) is not
   * silently dropped. Env-guarded — throws outside E2E/unit-test contexts.
   * Consumed by the desktop `e2e:clear-all-sessions` handler (including its
   * partial-failure early-return path) and cloud `resetSessions` via the
   * CloudServiceDeps seam.
   */
  clearHardDeleteLedgerForTestReset(): void {
    if (process.env.REBEL_E2E_TEST_MODE !== '1' && !process.env.VITEST) {
      throw new Error(
        'clearHardDeleteLedgerForTestReset() is test-reset-only (REBEL_E2E_TEST_MODE/VITEST); refusing to clear the hard-delete ledger in a real profile',
      );
    }
    this.hardDeletedSessionIds.clear();
    // Memory is now authoritative-empty; disk is removed below.
    this.hardDeleteLedgerDiskLoaded = true;
    fs.rmSync(this.deleteLedgerPath, { force: true });
    log.info('Hard-delete session ledger cleared for test reset');
  }

  private recordTombstonedSessionWriteDrop(
    sessionId: string,
    source: SessionWriteGuardSource,
  ): void {
    hardDeleteGuardCounters.rejectedWritesBySource[source] =
      (hardDeleteGuardCounters.rejectedWritesBySource[source] ?? 0) + 1;
    const now = Date.now();
    if (hardDeleteGuardCounters.firstRejectedAt === null) {
      hardDeleteGuardCounters.firstRejectedAt = now;
    }
    hardDeleteGuardCounters.lastRejectedAt = now;

    log.warn(
      {
        sessionIdHash: hashSessionIdForBreadcrumb(sessionId),
        source,
        rejectedCountForSource: hardDeleteGuardCounters.rejectedWritesBySource[source],
      },
      'Dropped session write for hard-deleted session id',
    );
  }

  /**
   * Drop tombstoned sessions from a write batch (delete-wins: a stale
   * whole-session snapshot must not recreate user-deleted data — across
   * renderer, cloud, and recovery writers, by construction at this chokepoint;
   * no caller-side guards).
   */
  private filterWritableSessions(
    sessions: AgentSession[],
    source: SessionWriteGuardSource,
  ): { sessions: AgentSession[]; droppedSessionIds: string[] } {
    const writableSessions: AgentSession[] = [];
    const droppedSessionIds: string[] = [];
    for (const session of sessions) {
      if (this.isHardDeletedSessionId(session.id)) {
        this.recordTombstonedSessionWriteDrop(session.id, source);
        droppedSessionIds.push(session.id);
        continue;
      }
      writableSessions.push(session);
    }
    return { sessions: writableSessions, droppedSessionIds };
  }

  private filterWritableIndexEntries(
    entries: SessionIndexEntry[],
    source: SessionWriteGuardSource,
  ): { entries: SessionIndexEntry[]; removedIds: string[] } {
    const writableEntries: SessionIndexEntry[] = [];
    const removedIds: string[] = [];
    for (const entry of entries) {
      if (this.isHardDeletedSessionId(entry.id)) {
        this.recordTombstonedSessionWriteDrop(entry.id, source);
        removedIds.push(entry.id);
        continue;
      }
      writableEntries.push(entry);
    }
    return { entries: writableEntries, removedIds };
  }

  /**
   * Best-effort quarantine of a stray ACTIVE session file for a tombstoned id
   * (moves it to sessions-deleted/ — recoverable, never destroyed). Skipped
   * entirely in read-only mode: when the mass-loss breaker has tripped, the
   * read-only-preserve-everything contract wins over cleanup (the tombstone
   * still hides the id from reads and writes).
   */
  private async quarantineTombstonedActiveSessionFile(
    sessionId: string,
    source: SessionWriteGuardSource,
  ): Promise<void> {
    if (sessionStoreReadOnlyMode || isUserDataReadOnly()) return;
    try {
      await this.softDeleteSessionFileAsync(sessionId);
      this.cachedFingerprints.delete(sessionId);
    } catch (err) {
      log.warn(
        { sessionIdHash: hashSessionIdForBreadcrumb(sessionId), source, err: getErrorMessage(err) },
        'Failed to remove tombstoned active session file during recovery',
      );
    }
  }

  /** Sync twin of quarantineTombstonedActiveSessionFile(). */
  private quarantineTombstonedActiveSessionFileSync(
    sessionId: string,
    source: SessionWriteGuardSource,
  ): void {
    if (sessionStoreReadOnlyMode || isUserDataReadOnly()) return;
    try {
      this.softDeleteSessionFile(sessionId);
      this.cachedFingerprints.delete(sessionId);
    } catch (err) {
      log.warn(
        { sessionIdHash: hashSessionIdForBreadcrumb(sessionId), source, err: getErrorMessage(err) },
        'Failed to remove tombstoned active session file during recovery',
      );
    }
  }

  /**
   * Read an index file synchronously, distinguishing TRANSIENT IO failure from
   * absence and corruption (REBEL-1C8). The single sync retry covers the EMFILE
   * window that graceful-fs cannot reach (it patches only callback APIs); if the
   * read still fails for a file that EXISTS, we return 'transient' rather than
   * letting the throw be misread as corruption upstream.
   *
   * ERROR-CODE SEMANTICS (F2b): ENOENT ⇒ 'absent'. Everything else (the file
   * exists but we couldn't read its bytes) ⇒ 'transient', because NONE of these
   * mean the JSON on disk is corrupt — corruption is "read OK but unparseable",
   * decided later by parseAndValidateIndex. We split the transient bucket only
   * for OBSERVABILITY, not behavior:
   *   - EMFILE/ENFILE  → retryable fd exhaustion (the single sync retry above).
   *   - EACCES/EISDIR/EPERM/other → likely PERMANENT/structural. We still treat
   *     it as 'transient' for DEGRADE purposes (never rebuild/overwrite a
   *     possibly-healthy index, prefer the in-memory/.bak path) but log LOUDLY
   *     at error level so a stuck state is visible rather than silently degrading
   *     forever. "transient" here means "do not treat as corruption / do not
   *     destroy disk", NOT "guaranteed to recover".
   */
  private readIndexFileSync(filePath: string): IndexReadResult {
    let content: string;
    try {
      content = withSingleSyncRetryOnEmfile(() => fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { kind: 'absent' };
      }
      const retryable = isTooManyOpenFilesError(err);
      const code = (err as NodeJS.ErrnoException).code;
      const likelyPermanent = code === 'EACCES' || code === 'EPERM' || code === 'EISDIR';
      if (likelyPermanent) {
        // Permanent/structural: still degrade-not-rebuild, but LOUD (error level)
        // so a stuck-unreadable index is observable, not silently empty forever.
        log.error(
          { err: getErrorMessage(err), filePath, code },
          'Session index file present but read failed with a likely-PERMANENT error (EACCES/EPERM/EISDIR) — degrading WITHOUT rebuild (not treated as corruption); investigate file permissions/path',
        );
      } else {
        log.warn(
          { err: getErrorMessage(err), filePath, transient: retryable, code },
          'Failed to read session index file (present but unreadable) — treating as TRANSIENT, not corrupt',
        );
      }
      try {
        getErrorReporter().captureException(err, {
          level: likelyPermanent ? 'error' : 'warning',
          fingerprint: [
            'session-index-transient-read',
            retryable ? 'emfile' : likelyPermanent ? 'permanent' : 'io',
          ],
          tags: { operation: 'incrementalSessionStore.readIndexFileSync' },
        });
      } catch (reporterErr) {
        ignoreBestEffortCleanup(reporterErr, {
          operation: 'incrementalSessionStore.readIndexFileSync.captureException',
          reason: 'transient-read observability is best-effort; a reporter failure must not change degrade behavior',
        });
      }
      return { kind: 'transient', error: err };
    }
    return { kind: 'read', content };
  }

  /**
   * Async twin of {@link readIndexFileSync}: EMFILE-retried, transient-aware.
   * Same ERROR-CODE SEMANTICS (F2b) — see readIndexFileSync.
   */
  private async readIndexFile(filePath: string): Promise<IndexReadResult> {
    let content: string;
    try {
      content = await withRetryOnEmfile(() => fs.promises.readFile(filePath, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { kind: 'absent' };
      }
      const retryable = isTooManyOpenFilesError(err);
      const code = (err as NodeJS.ErrnoException).code;
      const likelyPermanent = code === 'EACCES' || code === 'EPERM' || code === 'EISDIR';
      if (likelyPermanent) {
        log.error(
          { err: getErrorMessage(err), filePath, code },
          'Session index file present but read failed with a likely-PERMANENT error (EACCES/EPERM/EISDIR) — degrading WITHOUT rebuild (not treated as corruption); investigate file permissions/path',
        );
      } else {
        log.warn(
          { err: getErrorMessage(err), filePath, transient: retryable, code },
          'Failed to read session index file (present but unreadable) — treating as TRANSIENT, not corrupt',
        );
      }
      try {
        getErrorReporter().captureException(err, {
          level: likelyPermanent ? 'error' : 'warning',
          fingerprint: [
            'session-index-transient-read',
            retryable ? 'emfile' : likelyPermanent ? 'permanent' : 'io',
          ],
          tags: { operation: 'incrementalSessionStore.readIndexFile' },
        });
      } catch (reporterErr) {
        ignoreBestEffortCleanup(reporterErr, {
          operation: 'incrementalSessionStore.readIndexFile.captureException',
          reason: 'transient-read observability is best-effort; a reporter failure must not change degrade behavior',
        });
      }
      return { kind: 'transient', error: err };
    }
    return { kind: 'read', content };
  }

  /**
   * Degrade safely when index.json was present but transiently unreadable during
   * a full load. We NEVER rebuild-from-files and NEVER overwrite the primary
   * index on disk (those would needlessly rebuild — or worse destroy — a
   * probably-healthy index that was just momentarily unreadable). Disk is left
   * UNTOUCHED. Preference order for what to SERVE this attempt:
   *   1. the existing in-memory index (live corpus we already hold); else
   *   2. a good index.json.bak, served EPHEMERALLY (read into memory ONLY for
   *      THIS read; NOT assigned to this.index, NO primary heal/write) — so a
   *      populated sidebar is served instead of an empty one (F2a); else
   *   3. empty for THIS attempt (a later load re-reads the real corpus).
   *
   * WRITE-SAFETY INVARIANT (round-3 / GPT re-verify): a transient degrade MUST
   * NOT leave a backup-derived (non-authoritative) value in `this.index` — a
   * later writer would `ensureIndexLoadedForUpsert() → 'proceed'` and persist the
   * (possibly STALE) `.bak`-derived state over the healthy primary, HIDING
   * primary-only sessions. So the `.bak` is served EPHEMERALLY: `this.index`
   * stays whatever it was (null on first read). Writers therefore always reload
   * the authoritative primary (or defer) via ensureIndexLoadedForUpsert and never
   * persist `.bak`-derived state. Returns the sessions to serve AND the ephemeral
   * index used (so summary-deriving callers like listSessions can build from it
   * without touching this.index).
   *
   * Observable (logged + counted; the captureException already fired in
   * readIndexFile[Sync]).
   */
  private degradeOnTransientIndexRead(
    error: TransientIndexReadError,
    context: 'load' | 'loadSync',
  ): { sessions: AgentSession[]; ephemeralIndex: SessionIndex | null } {
    sessionStoreSafetyCounters.loadTransientIndexReadCount += 1;
    const haveInMemoryIndex = !!this.index;
    log.warn(
      {
        err: getErrorMessage(error.cause),
        context,
        haveInMemoryIndex,
        transientCount: sessionStoreSafetyCounters.loadTransientIndexReadCount,
      },
      'TRANSIENT-INDEX-READ LOAD DEGRADE: index.json present but transiently unreadable (EMFILE/IO); ' +
        'serving in-memory/.bak and leaving disk UNTOUCHED — NOT rebuilding or healing the primary from .bak',
    );
    if (this.index) {
      // The live in-memory corpus IS authoritative — serve it; nothing mutated.
      return { sessions: this.materializeSessionsFromIndex(this.index), ephemeralIndex: this.index };
    }
    // No in-memory index (e.g. first read at startup hit EMFILE). Serve a good
    // .bak EPHEMERALLY: read+validate into a local, materialize from it, but do
    // NOT assign this.index — keeping the write path governed solely by
    // ensureIndexLoadedForUpsert (which reloads the authoritative primary or
    // defers). This serves a populated sidebar while remaining write-safe by
    // construction (the .bak can never be persisted over the primary).
    const backup = this.readBackupIndexInMemorySync();
    if (backup) {
      sessionStoreSafetyCounters.loadTransientServedFromBackupCount += 1;
      log.warn(
        { recoveredSessionCount: backup.sessions.length },
        'TRANSIENT-INDEX-READ DEGRADE: serving index.json.bak EPHEMERALLY (NOT adopted into this.index; no primary write) instead of an empty sidebar',
      );
      return { sessions: this.materializeSessionsFromIndex(backup), ephemeralIndex: backup };
    }
    // No adoptable backup either — empty for this attempt; disk untouched.
    return { sessions: [], ephemeralIndex: null };
  }

  /**
   * Build the AgentSession[] shape `load()`/`loadSync()` return, from the given
   * index (defaults to `this.index`), WITHOUT touching disk. Used by the
   * transient-read degrade path — including the EPHEMERAL `.bak` serve, where we
   * pass the backup index explicitly and do NOT assign it to `this.index`. Each
   * entry's file is read on demand; a row whose file is also transiently
   * unreadable is skipped (observably) rather than failing the whole degrade.
   */
  private materializeSessionsFromIndex(index: SessionIndex | null = this.index): AgentSession[] {
    const sessions: AgentSession[] = [];
    for (const entry of index?.sessions ?? []) {
      try {
        const loaded = this.loadSessionFileSync(entry.id);
        if (loaded) sessions.push(loaded);
      } catch (err) {
        ignoreBestEffortCleanup(err, {
          operation: 'incrementalSessionStore.materializeSessionsFromIndex',
          reason: 'a single session file unreadable during transient-read degrade is skipped; the in-memory index row is preserved and the next load re-reads it',
        });
      }
    }
    return sessions;
  }

  /**
   * SINGLE shared parse+validate for an on-disk index payload (Stage 2 item 2).
   *
   * Returns a 4-way discriminated result — see {@link IndexValidationResult}.
   * "Usable as-is" ('ok') means: valid JSON object + numeric `version` equal to
   * INDEX_VERSION + `Array.isArray(sessions)` + EVERY entry is an object with a
   * present, filename-safe `id`. Version-mismatched payloads that are otherwise
   * structurally sound are classified as version-forward/-backward, NOT corrupt
   * (the mined eb93faddc validator's strict `version === INDEX_VERSION ⇒ null`
   * rule encoded the round-6 bug: it conflated "old format needing migration"
   * with "garbage" and silently dropped CLI writes — do not regress this).
   *
   * Entry validation (a present, valid `id` per entry) applies to ALL versions:
   * an index whose entries cannot drive file reads is unusable garbage no
   * matter what its version field claims.
   */
  private parseAndValidateIndex(content: string): IndexValidationResult {
    let parsed: SessionIndex;
    try {
      parsed = JSON.parse(content) as SessionIndex;
    } catch {
      return { status: 'corrupt' };
    }
    if (!parsed || typeof parsed !== 'object') return { status: 'corrupt' };
    if (typeof parsed.version !== 'number') return { status: 'corrupt' };
    if (!Array.isArray(parsed.sessions)) return { status: 'corrupt' };
    const everyEntryValid = parsed.sessions.every(
      (entry) =>
        entry != null &&
        typeof entry === 'object' &&
        typeof (entry as { id?: unknown }).id === 'string' &&
        this.isValidSessionId((entry as { id: string }).id),
    );
    if (!everyEntryValid) return { status: 'corrupt' };
    if (parsed.version > INDEX_VERSION) return { status: 'version-forward', index: parsed };
    if (parsed.version < INDEX_VERSION) return { status: 'version-backward', index: parsed };
    return { status: 'ok', index: parsed };
  }

  /**
   * Rolling backup-on-write for index.json (Stage 2 item 2; universal safety
   * net). Before overwriting the primary index, snapshot the existing file to
   * index.json.bak — but VALIDATE FIRST: a corrupt primary must NEVER clobber
   * the previously-good backup (the eb93faddc round-5 F1 clobber). Version-
   * mismatched primaries are real data and ARE backed up; only the 'corrupt'
   * leg skips.
   *
   * EMFILE/IO PRECEDENCE (pinned by test): this backup is best-effort — ANY
   * failure here (read or write) logs a warning and NEVER blocks the primary
   * write. We'd rather have a fresh primary than abort the user's save.
   * ENOENT (no prior index) is normal on first write.
   */
  private backupIndexBeforeWriteSync(): void {
    // EMFILE-retried, transient-aware read. A transient failure here SKIPS the
    // backup (continuing) rather than aborting the primary write or clobbering
    // the good .bak — backup is best-effort and a transient read is not
    // corruption.
    const read = this.readIndexFileSync(this.indexPath);
    if (read.kind === 'absent') {
      // No prior index.json to back up — normal on first write. ('absent' is a
      // first-class return of the read helper, not a swallowed catch.)
      return;
    }
    if (read.kind === 'transient') {
      log.warn('Transient read failure of index.json for backup-before-write (EMFILE/IO) — SKIPPING backup, continuing with the primary write');
      return;
    }
    const existing = read.content;
    if (this.parseAndValidateIndex(existing).status === 'corrupt') {
      sessionStoreSafetyCounters.backupSkippedInvalidPrimaryCount += 1;
      log.warn(
        { skippedCount: sessionStoreSafetyCounters.backupSkippedInvalidPrimaryCount },
        'index.json is present but corrupt/invalid; SKIPPING backup-on-write to preserve the good index.json.bak',
      );
      return;
    }
    try {
      writeFileSync(this.indexBackupPath, existing, 'utf8');
    } catch (err) {
      log.warn({ err: getErrorMessage(err) }, 'Failed to back up index.json before write (continuing)');
    }
  }

  /** Async variant of backupIndexBeforeWriteSync(). */
  private async backupIndexBeforeWrite(): Promise<void> {
    // See backupIndexBeforeWriteSync(): EMFILE-retried, transient-aware,
    // best-effort backup.
    const read = await this.readIndexFile(this.indexPath);
    if (read.kind === 'absent') {
      // No prior index.json to back up — normal on first write. ('absent' is a
      // first-class return of the read helper, not a swallowed catch.)
      return;
    }
    if (read.kind === 'transient') {
      log.warn('Transient read failure of index.json for backup-before-write (EMFILE/IO) — SKIPPING backup, continuing with the primary write');
      return;
    }
    const existing = read.content;
    if (this.parseAndValidateIndex(existing).status === 'corrupt') {
      sessionStoreSafetyCounters.backupSkippedInvalidPrimaryCount += 1;
      log.warn(
        { skippedCount: sessionStoreSafetyCounters.backupSkippedInvalidPrimaryCount },
        'index.json is present but corrupt/invalid; SKIPPING backup-on-write to preserve the good index.json.bak',
      );
      return;
    }
    try {
      await writeFile(this.indexBackupPath, existing, 'utf8');
    } catch (err) {
      log.warn({ err: getErrorMessage(err) }, 'Failed to back up index.json before write (continuing)');
    }
  }

  /**
   * SINGLE GUARDED CHOKEPOINT for every primary index.json overwrite (Stage 2
   * item 2). Every index write routes through this method (or its sync twin),
   * which ALWAYS takes the validate-first rolling backup before the atomic
   * primary write. The only writer that intentionally bypasses it is
   * recoverIndexFromBackupSync(), which is RESTORING the primary FROM the
   * backup (backing up again there would be pointless and could clobber the
   * good .bak with a partially-restored primary).
   *
   * Callers remain responsible for the read-only-mode gate and any breaker
   * consultation BEFORE calling this — this is the write+backup primitive, not
   * the policy layer. (Stage 3's producer-style harness asserts adoption.)
   */
  private async writeIndexFileAtomic(json: string): Promise<void> {
    await this.backupIndexBeforeWrite();
    await writeFile(this.indexPath, json, 'utf8');
  }

  /** Sync variant of writeIndexFileAtomic(): validate-first backup, then atomic write. */
  private writeIndexFileAtomicSync(json: string): void {
    this.backupIndexBeforeWriteSync();
    writeFileSync(this.indexPath, json, 'utf8');
  }

  /**
   * Recover index.json from index.json.bak when the primary is missing/corrupt,
   * BEFORE any rebuild-from-files (Stage 2 item 2). Returns the parsed,
   * version-current index on success (restoring the primary file from the
   * backup as a side effect), or null when no usable backup exists — the
   * caller then falls back to the existing rebuild/migration handling.
   *
   * Only a backup that validates as 'ok' (current version, every entry usable)
   * is adopted. A version-mismatched backup routes to the EXISTING version
   * handling via the rebuild fallback — backup recovery is for the 'corrupt'
   * leg only (FMM C-7).
   */
  private recoverIndexFromBackupSync(): SessionIndex | null {
    let content: string;
    try {
      content = fs.readFileSync(this.indexBackupPath, 'utf8');
    } catch (err) {
      // No backup (or unreadable) — caller falls back to rebuild-from-files.
      ignoreBestEffortCleanup(err, {
        operation: 'recoverIndexFromBackupSync.readBackup',
        reason: 'index.json.bak absent/unreadable; recovery falls back to rebuild-from-files',
      });
      return null;
    }
    const validated = this.parseAndValidateIndex(content);
    if (validated.status !== 'ok') {
      log.error(
        { backupStatus: validated.status },
        'index.json.bak is not adoptable as-is (corrupt or version-mismatched); falling through to rebuild-from-files',
      );
      return null;
    }
    // Restore the primary from the good backup so disk is healthy again.
    if (!sessionStoreReadOnlyMode) {
      try {
        fs.mkdirSync(this.sessionsDir, { recursive: true });
        writeFileSync(this.indexPath, content, 'utf8');
      } catch (healErr) {
        log.warn({ err: getErrorMessage(healErr) }, 'Failed to restore index.json from backup (continuing with in-memory copy)');
      }
    }
    sessionStoreSafetyCounters.indexRecoveredFromBackupCount += 1;
    log.error(
      {
        recoveredSessionCount: validated.index.sessions.length,
        recoveredCount: sessionStoreSafetyCounters.indexRecoveredFromBackupCount,
      },
      'Recovered index.json from index.json.bak (primary missing/corrupt) — avoided rebuild-from-files',
    );
    return validated.index;
  }

  /**
   * Read + validate index.json.bak into an in-memory index WITHOUT writing the
   * primary (unlike recoverIndexFromBackupSync, which heals the primary file on
   * disk). Used on the TRANSIENT-read degrade path: the primary index is
   * probably healthy — it was just unreadable this instant — so we must NOT
   * overwrite it from the backup. We only borrow the backup's contents to serve
   * a populated sidebar instead of an empty one. Returns the validated 'ok'
   * index, or null when no adoptable backup exists.
   */
  private readBackupIndexInMemorySync(): SessionIndex | null {
    const read = this.readIndexFileSync(this.indexBackupPath);
    if (read.kind !== 'read') {
      // Absent or also-transient — nothing safely adoptable from .bak.
      return null;
    }
    const validated = this.parseAndValidateIndex(read.content);
    if (validated.status !== 'ok') {
      log.warn(
        { backupStatus: validated.status },
        'index.json.bak not adoptable as-is on transient-degrade (corrupt or version-mismatched); degrading to empty',
      );
      return null;
    }
    return validated.index;
  }

  /**
   * MASS-LOSS CIRCUIT BREAKER for RECOVERY-CLASS bulk removals (Stage 2 item 1;
   * see the remover taxonomy at computeBulkRemovalBound()).
   *
   * Called by recovery-class paths (index prune on load, rebuild-from-files
   * prune) immediately BEFORE they drop sessions in aggregate. Returns true if
   * the removal is within the safe bound and may proceed; returns false — and
   * TRIPS the breaker: protective read-only mode + structured error + Sentry
   * capture — if it would remove an unsafe fraction of the corpus. On a trip
   * the caller MUST abort the destructive action and leave the on-disk index +
   * session files untouched (read-only-preserve-everything).
   *
   * NEVER call this from cleanupLeakedSessions (cap-and-continue policy — see
   * taxonomy), eviction, or TTL purges.
   */
  private guardRecoveryClassBulkRemoval(
    removeCount: number,
    totalCount: number,
    source: string,
  ): boolean {
    const maxAllowed = computeBulkRemovalBound(totalCount);
    if (removeCount <= maxAllowed) return true;

    sessionStoreSafetyCounters.bulkRemovalBreakerTrips += 1;
    enterProtectiveReadOnlyMode(
      'bulk-removal-breaker',
      'MASS-LOSS CIRCUIT BREAKER TRIPPED: a recovery-class bulk session removal would drop an unsafe fraction of the corpus. ' +
        'Aborting the destructive action, preserving the on-disk index + session files, and entering read-only mode. ' +
        'This indicates corrupt session state; see the manual recovery path documented at enterProtectiveReadOnlyMode().',
      {
        source,
        removeCount,
        totalCount,
        maxAllowed,
        absoluteFloor: BULK_REMOVAL_ABSOLUTE_FLOOR,
        maxFraction: BULK_REMOVAL_MAX_FRACTION,
      },
    );
    return false;
  }

  /**
   * Compute fingerprint for change detection.
   * CRITICAL: Must include ALL persisted fields that can change independently.
   * pin/star/delete/rename do NOT update updatedAt, so we include them explicitly.
   */
  private computeFingerprint(session: AgentSession): string {
    const msgCount = session.messages?.length ?? 0;
    const eventCount = Object.values(session.eventsByTurn ?? {}).reduce(
      (sum, events) => sum + events.length,
      0
    );

    // Use JSON.stringify for unambiguous serialization (avoids ':' collision)
    const metaFields = [
      session.title,
      // `doneAt` hashed so a done-toggle is detected dirty (done/star/delete do
      // NOT bump updatedAt). Canonical lifecycle field; see PLAN.md.
      session.doneAt ?? 0,
      session.starredAt ?? 0,
      session.deletedAt ?? 0,
      session.resolvedAt ?? 0,
      session.privateMode ? 1 : 0,
      session.lastError ?? '',
      session.activeTurnId ?? '',
      session.isBusy ? 1 : 0,
      session.origin ?? 'manual',
      session.cloudUpdatedAt ?? 0,
      session.maxSeq ?? 0,
      session.quotaWarning ? JSON.stringify(session.quotaWarning) : '',
      // Include counts for nested objects that can change independently
      Object.keys(session.memoryUpdateStatusByTurn ?? {}).length,
      Object.keys(session.timeSavedStatusByTurn ?? {}).length,
      (session.compactionBoundaries ?? []).length,
    ];

    return `${session.updatedAt}:${msgCount}:${eventCount}:${JSON.stringify(metaFields)}`;
  }

  /**
   * Validate session ID for safe filename usage.
   * Prevents path traversal and weird filenames.
   */
  private isValidSessionId(id: string): boolean {
    return /^[a-zA-Z0-9_-]+$/.test(id) && id.length > 0 && id.length < 100;
  }

  private sanitizeSessionForPersistence(session: AgentSession): { session: AgentSession; changed: boolean } {
    let eventsChanged = false;
    const sanitizedEventsByTurn: Record<string, AgentEvent[]> = {};

    for (const [turnId, events] of Object.entries(session.eventsByTurn ?? {})) {
      let turnChanged = false;
      const sanitizedEvents = events.map((event) => {
        const sanitized = sanitizeEventForMainAccumulation(event);
        if (sanitized !== event) {
          turnChanged = true;
        }
        return sanitized;
      });
      sanitizedEventsByTurn[turnId] = turnChanged ? sanitizedEvents : events;
      eventsChanged ||= turnChanged;
    }

    if (!eventsChanged) {
      return { session, changed: false };
    }

    return {
      session: {
        ...session,
        eventsByTurn: sanitizedEventsByTurn,
      },
      changed: true,
    };
  }

  private async getSessionAssetQuotaWarning(
    sessionId: string,
  ): Promise<QuotaCheckResult> {
    let assetStore: ReturnType<typeof getAssetStore>;
    try {
      assetStore = getAssetStore();
    } catch (err) {
      log.debug(
        { sessionIdHash: hashSessionIdForBreadcrumb(sessionId), err: getErrorMessage(err) },
        'Skipping session asset quota check because AssetStore is not initialized',
      );
      return { status: 'unavailable', error: err };
    }

    let assetIds: string[];
    let assetChecks: Awaited<ReturnType<typeof assetStore.hasAsset>>[];
    try {
      assetIds = await assetStore.listSessionAssets({ sessionId });
      // Bounded fan-out (defense-in-depth, SESSION_STORE_FS_CONCURRENCY) —
      // order-preserving and reject-fast, identical to the prior Promise.all.
      assetChecks = await mapWithConcurrencyLimit(
        assetIds,
        SESSION_STORE_FS_CONCURRENCY,
        (assetId) => assetStore.hasAsset({ sessionId, assetId }),
      );
    } catch (err) {
      log.warn(
        { sessionIdHash: hashSessionIdForBreadcrumb(sessionId), err: getErrorMessage(err) },
        'Session asset quota check failed; persisting session without quota warning update',
      );
      return { status: 'unavailable', error: err };
    }
    const bytes = assetChecks.reduce(
      (sum, result) => sum + (result.has && typeof result.byteSize === 'number' ? result.byteSize : 0),
      0,
    );

    if (assetIds.length > MAX_SESSION_ASSETS) {
      recordAssetResolutionFailure({
        sessionId,
        reason: 'quota-exceeded',
        context: 'quota',
        metadata: {
          count: assetIds.length,
          maxAssets: MAX_SESSION_ASSETS,
          bytes,
          maxBytes: MAX_SESSION_ASSET_BYTES,
          quotaKind: 'asset-count-exceeded',
        },
        log,
      });
      return {
        status: 'warning',
        warning: {
          kind: 'asset-count-exceeded',
          count: assetIds.length,
          bytes,
        },
      };
    }

    if (bytes > MAX_SESSION_ASSET_BYTES) {
      recordAssetResolutionFailure({
        sessionId,
        reason: 'quota-exceeded',
        context: 'quota',
        metadata: {
          count: assetIds.length,
          maxAssets: MAX_SESSION_ASSETS,
          bytes,
          maxBytes: MAX_SESSION_ASSET_BYTES,
          quotaKind: 'asset-bytes-exceeded',
        },
        log,
      });
      return {
        status: 'warning',
        warning: {
          kind: 'asset-bytes-exceeded',
          count: assetIds.length,
          bytes,
        },
      };
    }

    return { status: 'within' };
  }

  private async prepareSessionForPersistence(
    session: AgentSession,
  ): Promise<{ session: AgentSession; changed: boolean }> {
    const sanitized = this.sanitizeSessionForPersistence(session);
    const quotaCheck = await this.getSessionAssetQuotaWarning(session.id);
    const existingWarning = sanitized.session.quotaWarning;
    if (quotaCheck.status === 'unavailable') {
      log.warn(
        {
          sessionIdHash: hashSessionIdForBreadcrumb(session.id),
          err: getErrorMessage(quotaCheck.error),
          preservedExistingWarning: Boolean(existingWarning),
        },
        'Session asset quota check unavailable; preserving existing quota warning',
      );
      return sanitized;
    }

    const quotaWarning = quotaCheck.status === 'warning' ? quotaCheck.warning : undefined;
    const quotaChanged = JSON.stringify(existingWarning ?? null) !== JSON.stringify(quotaWarning ?? null);

    if (!quotaChanged) {
      return sanitized;
    }

    const nextSession: AgentSession = {
      ...sanitized.session,
      ...(quotaWarning ? { quotaWarning } : {}),
    };
    if (!quotaWarning) {
      delete nextSession.quotaWarning;
    }
    return { session: nextSession, changed: true };
  }

  private prepareSessionForPersistenceSync(session: AgentSession): { session: AgentSession; changed: boolean } {
    return this.sanitizeSessionForPersistence(session);
  }

  private async prepareSessionsForPersistence(
    sessions: AgentSession[],
  ): Promise<{ sessions: AgentSession[]; forceChangedIds: Set<string> }> {
    const forceChangedIds = new Set<string>();
    // Bounded fan-out (defense-in-depth, SESSION_STORE_FS_CONCURRENCY) —
    // `prepared` is consumed positionally, so order MUST match `sessions`;
    // mapWithConcurrencyLimit preserves it (results[index]). forceChangedIds is
    // a Set keyed by id, order-independent.
    const prepared = await mapWithConcurrencyLimit(
      sessions,
      SESSION_STORE_FS_CONCURRENCY,
      async (session) => {
        const result = await this.prepareSessionForPersistence(session);
        if (result.changed) {
          forceChangedIds.add(session.id);
        }
        return result.session;
      },
    );
    return { sessions: prepared, forceChangedIds };
  }

  private prepareSessionsForPersistenceSync(
    sessions: AgentSession[],
  ): { sessions: AgentSession[]; forceChangedIds: Set<string> } {
    const forceChangedIds = new Set<string>();
    const prepared = sessions.map((session) => {
      const result = this.prepareSessionForPersistenceSync(session);
      if (result.changed) {
        forceChangedIds.add(session.id);
      }
      return result.session;
    });
    return { sessions: prepared, forceChangedIds };
  }

  private stampDerivedLiveness(session: AgentSession, now: number = Date.now()): AgentSession {
    const derived = deriveTurnLiveness(session.eventsByTurn, now);
    const stampedScalars = this.toPersistedBusyScalarsForWrite(session, derived);
    if (
      session.isBusy === stampedScalars.isBusy &&
      session.activeTurnId === stampedScalars.activeTurnId
    ) {
      return session;
    }
    return {
      ...session,
      ...stampedScalars,
    };
  }

  /**
   * Write-path companion to `toPersistedBusyScalars` in
   * `conversationState/toPersistedBusyScalars.ts`.
   *
   * Both functions encode one policy with one intentional divergence:
   * write-time `interrupted` preserves busy so persisted snapshots do not clear
   * a potentially live turn just because this surface lacks fresh events;
   * load/read projections then apply the canonical interrupted->idle mapping.
   * See docs/plans/260530_turn_liveness_projection.md (Phase 7, P7-3).
   */
  private toPersistedBusyScalarsForWrite(
    session: AgentSession,
    derived: ReturnType<typeof deriveTurnLiveness>,
  ): { isBusy: boolean; activeTurnId: string | null } {
    if (!session.activeTurnId) {
      return {
        isBusy: false,
        activeTurnId: null,
      };
    }

    switch (derived.status) {
      case 'running':
      case 'interrupted':
        return {
          isBusy: true,
          activeTurnId: derived.activeTurnId,
        };
      case 'terminal':
      case 'idle':
        return {
          isBusy: false,
          activeTurnId: null,
        };
    }
  }

  private persistSessionToDiskSync(
    filePath: string,
    session: AgentSession,
    now: number = Date.now(),
  ): { session: AgentSession; json: string } {
    const stampedSession = this.stampDerivedLiveness(session, now);
    const json = JSON.stringify(stampedSession);
    writeFileSync(filePath, json, 'utf8');
    return { session: stampedSession, json };
  }

  private async persistSessionToDisk(
    filePath: string,
    session: AgentSession,
    now: number = Date.now(),
  ): Promise<{ session: AgentSession; json: string }> {
    const stampedSession = this.stampDerivedLiveness(session, now);
    const json = JSON.stringify(stampedSession);
    await writeFile(filePath, json, 'utf8');
    return { session: stampedSession, json };
  }

  /**
   * Get path to a session file.
   */
  getSessionFilePath(sessionId: string): string {
    if (!this.isValidSessionId(sessionId)) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  /**
   * Soft-delete a session file by moving it to sessions-deleted/ (sync).
   * Throws on failure to ensure the caller doesn't update index/cache for a file still in sessions/.
   */
  private softDeleteSessionFile(sessionId: string): void {
    const srcPath = this.getSessionFilePath(sessionId);
    if (!fs.existsSync(srcPath)) return;

    fs.mkdirSync(this.deletedSessionsDir, { recursive: true });
    const destPath = path.join(this.deletedSessionsDir, `${sessionId}_${Date.now()}.json`);

    try {
      fs.renameSync(srcPath, destPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        // Cross-device: copy first, only unlink if copy succeeded (duplication > data loss)
        fs.copyFileSync(srcPath, destPath);
        try { fs.unlinkSync(srcPath); } catch { /* file in both locations is safe */ }
      } else {
        throw err;
      }
    }
    log.info({ sessionId, destPath }, 'Session file soft-deleted');
  }

  /**
   * Soft-delete a session file by moving it to sessions-deleted/ (async).
   * Throws on failure to ensure the caller doesn't update index/cache for a file still in sessions/.
   */
  private async softDeleteSessionFileAsync(sessionId: string): Promise<number | null> {
    const srcPath = this.getSessionFilePath(sessionId);
    try {
      await fs.promises.access(srcPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }

    await fs.promises.mkdir(this.deletedSessionsDir, { recursive: true });
    const deletedTimestamp = Date.now();
    const destPath = path.join(this.deletedSessionsDir, `${sessionId}_${deletedTimestamp}.json`);

    try {
      await fs.promises.rename(srcPath, destPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        // Cross-device: copy first, only unlink if copy succeeded (duplication > data loss)
        await fs.promises.copyFile(srcPath, destPath);
        try { await fs.promises.unlink(srcPath); } catch { /* file in both locations is safe */ }
      } else {
        throw err;
      }
    }
    log.info({ sessionId, destPath }, 'Session file soft-deleted');
    return deletedTimestamp;
  }

  /**
   * Async save - queues write and returns immediately.
   * Only writes changed sessions based on fingerprint comparison.
   * Uses .catch() to prevent queue from getting stuck on errors.
   */
  async save(sessions: AgentSession[]): Promise<void> {
    if (sessionStoreReadOnlyMode) { log.warn('Session store in read-only mode, skipping save'); return; }
    this.pendingSessions = sessions;
    // Chain with error recovery to prevent queue from getting stuck
    this.writeQueue = this.writeQueue
      .then(() => this.flush())
      .catch((error) => {
        // Log but don't rethrow - allows queue to continue processing
        log.error({ err: error }, 'Async flush failed, queue continues');
      });
    return this.writeQueue;
  }

  /**
   * Synchronous save for beforeunload.
   * Only writes changed sessions to minimize blocking time.
   */
  saveSync(sessions: AgentSession[]): void {
    if (sessionStoreReadOnlyMode) { log.warn('Session store in read-only mode, skipping saveSync'); return; }
    const startTime = Date.now();

    try {
      // Ensure sessions directory exists
      if (!fs.existsSync(this.sessionsDir)) {
        fs.mkdirSync(this.sessionsDir, { recursive: true });
      }

      // Anomaly diagnostic runs on the FULL incoming batch, before tombstone
      // filtering — a drop-emptied batch must still be observable (peer graft,
      // c0686de42).
      this.logSaveBatchSizeDiagnostic(sessions);

      // Only short-circuit when the batch became empty BECAUSE of tombstone
      // drops — an originally-empty batch must keep today's behavior.
      const writableInput = this.filterWritableSessions(sessions, 'saveSync');
      if (writableInput.sessions.length === 0 && writableInput.droppedSessionIds.length > 0) return;

      const prepared = this.prepareSessionsForPersistenceSync(writableInput.sessions);
      const { changedSessions, newFingerprints } = this.computeUpserts(
        prepared.sessions,
        prepared.forceChangedIds,
      );

      // Write changed session files
      const stampedSessionsById = new Map<string, AgentSession>();
      for (const session of changedSessions) {
        const filePath = this.getSessionFilePath(session.id);
        const persisted = this.persistSessionToDiskSync(filePath, session);
        stampedSessionsById.set(persisted.session.id, persisted.session);
        newFingerprints.set(persisted.session.id, this.computeFingerprint(persisted.session));
      }
      const sessionsForIndex = prepared.sessions.map(
        (session) => stampedSessionsById.get(session.id) ?? session,
      );

      // Update index (UNION merge — preserves existing entries)
      this.writeIndexSync(sessionsForIndex);

      // Update fingerprint cache (additive)
      for (const [id, fp] of newFingerprints) {
        this.cachedFingerprints.set(id, fp);
      }

      const duration = Date.now() - startTime;
      log.debug(
        {
          duration,
          totalSessions: prepared.sessions.length,
          changedCount: changedSessions.length,
        },
        'Sync incremental save completed'
      );
    } catch (error) {
      log.error({ err: error, duration: Date.now() - startTime }, 'Sync incremental save failed');
      throw error;
    }
  }

  /**
   * Synchronous upsert for beforeunload - merges sessions into existing index.
   * Unlike saveSync which overwrites the index, this preserves existing entries.
   * Only writes changed sessions to minimize blocking time.
   */
  upsertSessionsSync(sessions: AgentSession[]): SessionsSyncUpsertOutcome {
    return this.upsertSessionsSyncInternal(sessions, { forceReloadIndex: false });
  }

  /**
   * Synchronous upsert for cross-process writers.
   * Caller must hold the global index lock before invoking this method.
   */
  upsertSessionsSyncWithReload(sessions: AgentSession[]): SessionsSyncUpsertOutcome {
    return this.upsertSessionsSyncInternal(sessions, { forceReloadIndex: true });
  }

  private upsertSessionsSyncInternal(
    sessions: AgentSession[],
    options: { forceReloadIndex: boolean },
  ): SessionsSyncUpsertOutcome {
    if (sessionStoreReadOnlyMode) {
      log.warn('Session store in read-only mode, skipping upsertSessionsSync');
      return { outcome: 'dropped', reason: 'read-only' };
    }
    if (sessions.length === 0) return { outcome: 'noop-empty-batch' };

    // Stage 3 ledger re-read (rev-2, C-17): at the TOP of the reload-upsert
    // path, BEFORE filterWritableSessions runs on the incoming batch, and
    // INSIDE the same lock window as the index re-read (the caller holds the
    // global index lock around this whole method for the reload variant) —
    // NOT buried in readIndexFromDiskForUpsert, where the input filter would
    // already have run against a stale in-memory set. UNION semantics: disk
    // ids merge into the in-memory set, never replace it.
    if (options.forceReloadIndex) {
      this.reloadHardDeleteLedgerForCrossProcessUpsert();
    }

    const writableInput = this.filterWritableSessions(sessions, 'upsertSessionsSyncInternal');
    if (writableInput.sessions.length === 0) {
      return {
        outcome: 'all-dropped-tombstoned',
        droppedTombstonedSessionIds: writableInput.droppedSessionIds,
      };
    }

    const startTime = Date.now();
    const prepared = this.prepareSessionsForPersistenceSync(writableInput.sessions);

    try {
      // Ensure sessions directory exists
      if (!fs.existsSync(this.sessionsDir)) {
        fs.mkdirSync(this.sessionsDir, { recursive: true });
      }

      // Load existing index (or use in-memory if available). Cross-process
      // writers call the reload variant while holding the index lock so a stale
      // per-process cache cannot drop another process's index entry.
      //
      // Stage 2 item 2 (eb93faddc round-5 Part B, fixed for the round-6 edge):
      // never write a shrunken index over a populated-but-unreadable one. The
      // discriminated read distinguishes the cases the old `null` conflated:
      //  - 'absent'           → fresh start; init an empty index below.
      //  - 'version-backward' → migration-needing, NOT corrupt: preserve
      //    today's write-through (the CLI/headless edge — migration runs at the
      //    next full load()).
      //  - 'version-forward'  → a newer app owns this data: observable no-write
      //    consistent with the existing forward-version read-only protection.
      //  - 'corrupt'          → recover the FULL index from .bak, or abort
      //    read-only (never persist a shrunken index that masks the corpus).
      let currentIndex: SessionIndex | null = options.forceReloadIndex ? null : this.index;
      if (options.forceReloadIndex || !currentIndex) {
        const read = this.readIndexFromDiskForUpsert();
        switch (read.status) {
          case 'ok':
          case 'version-backward':
            currentIndex = read.index;
            break;
          case 'version-forward':
            sessionStoreSafetyCounters.reloadUpsertAbortedVersionForwardCount += 1;
            enterProtectiveReadOnlyMode(
              'reload-upsert-version-forward',
              'Reload-upsert found an index written by a NEWER app version; dropping the write and entering read-only mode to protect data',
              {
                indexVersion: read.index.version,
                appIndexVersion: INDEX_VERSION,
                droppedSessionCount: sessions.length,
              },
            );
            return { outcome: 'dropped', reason: 'version-forward-index' };
          case 'corrupt': {
            const recovered = this.recoverIndexFromBackupSync();
            if (recovered) {
              currentIndex = recovered;
            } else {
              // No usable backup. Do NOT write: a shrunken index here would
              // mask the populated-but-corrupt corpus. Abort the upsert (the
              // caller sees the drop), enter read-only mode, and leave the
              // session files + the untouched primary/.bak in place so the
              // next full load() can rebuild the complete corpus.
              sessionStoreSafetyCounters.reloadUpsertAbortedCorruptIndexCount += 1;
              enterProtectiveReadOnlyMode(
                'reload-upsert-corrupt-index',
                'CORRUPT-INDEX UPSERT ABORT: index.json is corrupt AND index.json.bak is unusable. ' +
                  'Refusing to write a shrunken index that would mask the existing corpus; entering read-only mode.',
                { droppedSessionCount: sessions.length },
              );
              return { outcome: 'dropped', reason: 'corrupt-index-unrecoverable' };
            }
            break;
          }
          case 'transient': {
            // Present-but-unreadable this time (EMFILE/ENFILE/transient IO) — NOT
            // corruption. Treating it as 'absent' would write a shrunken/empty
            // index over a healthy corpus; treating it as 'corrupt' would trigger
            // needless .bak recovery. Drop this write (observably) and leave the
            // on-disk index untouched so the next attempt reads the real index.
            sessionStoreSafetyCounters.reloadUpsertTransientIndexReadCount += 1;
            log.warn(
              {
                droppedSessionCount: sessions.length,
                transientCount: sessionStoreSafetyCounters.reloadUpsertTransientIndexReadCount,
              },
              'TRANSIENT-INDEX-READ UPSERT DEFER: index.json present but transiently unreadable (EMFILE/IO); dropping this write WITHOUT rebuilding or recovering — the index is left untouched for the next attempt',
            );
            return { outcome: 'dropped', reason: 'transient-index-read' };
          }
          case 'absent':
            break; // Fresh start — initialize an empty index below.
        }
      }

      // Initialize index if needed
      if (!currentIndex) {
        currentIndex = {
          version: INDEX_VERSION,
          lastUpdated: Date.now(),
          sessions: [],
        };
      }

      // Stage 3: prune tombstoned ids that are still present in the (possibly
      // just-reloaded or .bak-recovered) index, quarantining their stray
      // files. The prune routes through the mass-loss breaker (rev-2, RS F14):
      // >bound tombstoned rows — e.g. in a recovered index.json.bak — is a
      // corruption smell that trips read-only LOUDLY by design, preserving
      // disk untouched (the tombstones still hide those ids from reads).
      const prunedCurrentIndex = this.filterWritableIndexEntries(
        currentIndex.sessions,
        'upsertSessionsSyncInternal',
      );
      if (prunedCurrentIndex.removedIds.length > 0) {
        if (
          !this.guardRecoveryClassBulkRemoval(
            prunedCurrentIndex.removedIds.length,
            currentIndex.sessions.length,
            'upsertSessionsSyncInternal:tombstoned-index-prune',
          )
        ) {
          // Breaker tripped → store is now read-only; drop this write and
          // leave the on-disk index + session files untouched.
          return { outcome: 'dropped', reason: 'read-only' };
        }
        for (const id of prunedCurrentIndex.removedIds) {
          this.quarantineTombstonedActiveSessionFileSync(id, 'upsertSessionsSyncInternal');
        }
        currentIndex.sessions = prunedCurrentIndex.entries;
      }

      const writeStart = Date.now();

      // Write session files and update index entries
      for (const session of prepared.sessions) {
        // Write session file
        const filePath = this.getSessionFilePath(session.id);
        const persisted = this.persistSessionToDiskSync(filePath, session);
        const persistedSession = persisted.session;

        // Update index entry. F3 containment: the session FILE is already
        // written above, so a malformed-field throw here must not abort the whole
        // upsert (the file would become an unindexed orphan). Route through the
        // contained builder — a corrupt session lands as a degraded row.
        const upsertContained = { skipped: 0, corrupted: 0 };
        const summary = this.buildContainedIndexEntry(
          persistedSession,
          'upsertSessionsSyncInternal',
          upsertContained,
        );
        if (summary) {
          const existingIdx = currentIndex.sessions.findIndex((s) => s.id === session.id);
          if (existingIdx >= 0) {
            currentIndex.sessions[existingIdx] = summary;
          } else {
            currentIndex.sessions.push(summary);
          }
          // Update fingerprint cache
          this.cachedFingerprints.set(session.id, summary.fingerprint);
        }
      }

      // Write updated index (via the single guarded chokepoint: backup-then-write)
      currentIndex.lastUpdated = Date.now();
      this.writeIndexFileAtomicSync(JSON.stringify(currentIndex));
      this.index = currentIndex;

      const writeDurationMs = Date.now() - writeStart;
      import('./perfAccumulator').then(({ recordStoreWrite }) => {
        recordStoreWrite(writeDurationMs, `session.upsertSync(${sessions.length})`);
      }).catch(() => { /* ignore import errors */ });

      const duration = Date.now() - startTime;
      log.debug(
        { duration, sessionCount: prepared.sessions.length },
        'Sync upsert completed (preserved existing index entries)'
      );
      return {
        outcome: 'persisted',
        persistedSessionIds: prepared.sessions.map((session) => session.id),
        droppedTombstonedSessionIds: writableInput.droppedSessionIds,
      };
    } catch (error) {
      log.error({ err: error, duration: Date.now() - startTime }, 'Sync upsert failed');
      throw error;
    }
  }

  /**
   * Read the primary index for the reload-upsert path, discriminating the
   * failure modes the caller must treat differently (Stage 2 item 2):
   *
   *  - 'absent'           — ENOENT: normal first run / brand-new store.
   *  - 'ok'               — fully usable, current-version index.
   *  - 'version-backward' — older format needing migration; usable for
   *                         write-through (round-6 CLI edge: NOT corrupt).
   *  - 'version-forward'  — written by a newer app; the caller must not write.
   *  - 'corrupt'          — exists but unusable (read error, garbage JSON,
   *                         malformed entries). The caller MUST NOT treat this
   *                         as empty: doing so writes a shrunken index over a
   *                         populated-but-corrupt one.
   */
  private readIndexFromDiskForUpsert():
    | IndexValidationResult
    | { status: 'absent' }
    | { status: 'transient' } {
    const read = this.readIndexFileSync(this.indexPath);
    if (read.kind === 'absent') return { status: 'absent' };
    if (read.kind === 'transient') {
      // Present-but-unreadable this time (EMFILE/ENFILE/transient IO). This is
      // NOT corruption — do NOT enter .bak recovery; the caller drops the write
      // and leaves the on-disk index untouched so the next attempt can read it.
      return { status: 'transient' };
    }
    const validated = this.parseAndValidateIndex(read.content);
    if (validated.status === 'corrupt') {
      log.warn('index.json present but unparseable/invalid for upsert — treating as corrupt');
    }
    return validated;
  }

  /**
   * Load all sessions from disk (async version).
   * Handles migration from legacy format, agent-sessions recovery, and index recovery.
   */
  async load(): Promise<AgentSession[]> {
    try {
      // Stage 0: Migrate any orphaned data from agent-sessions/ (partial SessionStorageService impl)
      if (fs.existsSync(this.agentSessionsDir)) {
        await this.migrateFromAgentSessions();
      }

      // Check if new format exists
      if (fs.existsSync(this.indexPath)) {
        try {
          return await this.loadFromNewFormat();
        } catch (error) {
          // TRANSIENT read failure (EMFILE/IO) is NOT corruption — degrade
          // safely WITHOUT .bak recovery or rebuild (which would destroy/rebuild
          // a possibly-healthy index). Keep the in-memory index if present, else
          // return empty; the next load attempt re-reads the real index.
          if (isTransientIndexReadError(error)) {
            return this.degradeOnTransientIndexRead(error, 'load').sessions;
          }
          // Index corrupted. BEFORE rebuilding from files, try to recover the
          // index from index.json.bak (Stage 2 item 2) — a clean recovery
          // sidesteps the rebuild path entirely. Version mismatches do NOT
          // reach this catch (loadFromNewFormat routes them to the existing
          // read-only/rebuild handling); only genuine corruption does.
          log.warn({ err: error }, 'Index corrupted, attempting recovery from index.json.bak');
          if (this.recoverIndexFromBackupSync()) {
            try {
              return await this.loadFromNewFormat();
            } catch (retryErr) {
              log.warn({ err: retryErr }, 'Index still unusable after .bak recovery, rebuilding from session files');
            }
          }
          return this.rebuildIndexFromFiles();
        }
      }

      // Check if sessions dir exists but index is missing (crash recovery)
      if (fs.existsSync(this.sessionsDir)) {
        const files = await fs.promises.readdir(this.sessionsDir);
        const sessionFiles = files.filter(isSessionFile);
        if (sessionFiles.length > 0) {
          log.warn(
            { fileCount: sessionFiles.length },
            'Index missing but session files exist - rebuilding'
          );
          return this.rebuildIndexFromFiles();
        }
      }

      // Try legacy migration
      if (fs.existsSync(this.legacyPath)) {
        return this.migrateFromLegacy();
      }

      // Fresh install
      return [];
    } catch (error) {
      log.error({ err: error }, 'Failed to load sessions');
      // OBSERVABILITY (Pathologist Rec 1): a catastrophic load failure empties the
      // sidebar but is otherwise INVISIBLE — the original index-collapse disaster
      // produced 0 Sentry events in 30d because this `return []` swallows the
      // error. Report it (genuine-error catch path only; the fresh-install/empty
      // happy path returns above without throwing, so benign empty states are NOT
      // reported). Recovery behavior is unchanged (still `return []`).
      //
      // F1 (GPT review): the reporter boundary forwards straight to Sentry with
      // NO surrounding catch — if captureException throws, it would skip the
      // `return []` recovery it exists to OBSERVE (telemetry replacing recovery).
      // Guard it locally so a reporter failure can never alter load recovery.
      try {
        getErrorReporter().captureException(error, {
          level: 'error',
          fingerprint: ['session-store-load-failed', 'async'],
          tags: { operation: 'incrementalSessionStore.load' },
        });
      } catch (reporterErr) {
        ignoreBestEffortCleanup(reporterErr, {
          operation: 'incrementalSessionStore.load.captureException',
          reason: 'error reporting is best-effort observability; a reporter failure must NOT skip the load `return []` recovery it is meant to observe',
        });
      }
      return [];
    }
  }

  /**
   * Load all sessions from disk (sync version for startup).
   * Handles migration from legacy format, agent-sessions recovery, and index recovery.
   */
  loadSync(): AgentSession[] {
    try {
      // Stage 0: Migrate any orphaned data from agent-sessions/ (partial SessionStorageService impl)
      if (fs.existsSync(this.agentSessionsDir)) {
        this.migrateFromAgentSessionsSync();
      }

      // Check if new format exists
      if (fs.existsSync(this.indexPath)) {
        try {
          return this.loadFromNewFormatSync();
        } catch (error) {
          // TRANSIENT read failure (EMFILE/IO) — degrade, do NOT recover/rebuild
          // (see load()).
          if (isTransientIndexReadError(error)) {
            return this.degradeOnTransientIndexRead(error, 'loadSync').sessions;
          }
          // Index corrupted — try .bak recovery before rebuild (see load()).
          log.warn({ err: error }, 'Index corrupted, attempting recovery from index.json.bak (sync)');
          if (this.recoverIndexFromBackupSync()) {
            try {
              return this.loadFromNewFormatSync();
            } catch (retryErr) {
              log.warn({ err: retryErr }, 'Index still unusable after .bak recovery, rebuilding from session files (sync)');
            }
          }
          return this.rebuildIndexFromFilesSync();
        }
      }

      // Check if sessions dir exists but index is missing (crash recovery)
      if (fs.existsSync(this.sessionsDir)) {
        const files = fs.readdirSync(this.sessionsDir);
        const sessionFiles = files.filter(isSessionFile);
        if (sessionFiles.length > 0) {
          log.warn(
            { fileCount: sessionFiles.length },
            'Index missing but session files exist - rebuilding synchronously'
          );
          return this.rebuildIndexFromFilesSync();
        }
      }

      // Try legacy migration (sync)
      if (fs.existsSync(this.legacyPath)) {
        return this.migrateFromLegacySync();
      }

      // Fresh install
      return [];
    } catch (error) {
      log.error({ err: error }, 'Failed to load sessions');
      // OBSERVABILITY (Pathologist Rec 1): see load() above — a catastrophic sync
      // load failure empties the sidebar invisibly. Report it (genuine-error catch
      // only; fresh-install happy path returns above). Recovery unchanged.
      //
      // F1 (GPT review): guard the reporter call locally — it forwards straight to
      // Sentry with no surrounding catch, so a reporter throw would skip the
      // `return []` recovery it exists to observe.
      try {
        getErrorReporter().captureException(error, {
          level: 'error',
          fingerprint: ['session-store-load-failed', 'sync'],
          tags: { operation: 'incrementalSessionStore.loadSync' },
        });
      } catch (reporterErr) {
        ignoreBestEffortCleanup(reporterErr, {
          operation: 'incrementalSessionStore.loadSync.captureException',
          reason: 'error reporting is best-effort observability; a reporter failure must NOT skip the loadSync `return []` recovery it is meant to observe',
        });
      }
      return [];
    }
  }

  /**
   * Check if there's a pending write.
   */
  hasPendingWrite(): boolean {
    return this.pendingSessions !== null || this.isWriting;
  }

  /**
   * Wait for pending writes to complete.
   */
  async waitForPendingWrites(): Promise<void> {
    await this.flushPendingWrites();
  }

  /**
   * Flush any queued session writes to disk.
   *
   * Only flushes writes already queued in the main process write queue.
   * Does NOT trigger a renderer-side flush — data still in the renderer's
   * persistence debounce buffer (~300ms) is not captured by this call.
   * The renderer's beforeunload handler is responsible for flushing its buffer.
   */
  async flushPendingWrites(): Promise<void> {
    await this.writeQueue;
  }

  /**
   * Compute which sessions have changed since last save (upsert-only, no deletions).
   * Bulk saves never delete session files — deletions only happen via sessions:delete.
   */
  private logSaveBatchSizeDiagnostic(sessions: AgentSession[]): void {
    // Anomaly detection: warn when the incoming batch is significantly smaller than known sessions.
    // With upsert-only semantics this can't cause data loss, but a suspiciously small batch
    // (e.g. renderer save before loading completes) is worth flagging for diagnostics.
    // Hoisted out of computeUpserts (peer graft, c0686de42): must run on the FULL incoming
    // batch BEFORE tombstone (delete-wins) filtering, so drop-emptied batches still log.
    const knownCount = this.index?.sessions.length ?? this.cachedFingerprints.size;
    const MIN_KNOWN_FOR_CHECK = 10;
    const ANOMALY_THRESHOLD = 0.05; // 5% — even losing 50 of 1000 in a batch is suspicious
    if (knownCount >= MIN_KNOWN_FOR_CHECK && sessions.length < knownCount * ANOMALY_THRESHOLD) {
      log.error(
        { batchSize: sessions.length, knownCount, dropRate: Math.round((1 - sessions.length / knownCount) * 100) },
        'ANOMALY: save batch is <5% of known sessions — likely a renderer race condition (no data lost due to upsert-only semantics)'
      );
    } else if (knownCount > 0 && sessions.length < knownCount * 0.5) {
      log.info(
        { batchSize: sessions.length, knownCount },
        'Partial save: batch smaller than known session count (expected with lazy loading)'
      );
    }
  }

  private computeUpserts(sessions: AgentSession[], forceChangedIds: ReadonlySet<string> = new Set()): {
    changedSessions: AgentSession[];
    newFingerprints: Map<string, string>;
  } {
    const changedSessions: AgentSession[] = [];
    const newFingerprints = new Map<string, string>();

    for (const session of sessions) {
      const fp = this.computeFingerprint(session);
      newFingerprints.set(session.id, fp);

      const cached = this.cachedFingerprints.get(session.id);
      if (cached !== fp || forceChangedIds.has(session.id)) {
        changedSessions.push(session);
      }
    }

    return { changedSessions, newFingerprints };
  }

  /**
   * Flush pending writes to disk.
   */
  private async flush(): Promise<void> {
    if (!this.pendingSessions) {
      return;
    }

    const pendingSessions = this.pendingSessions;
    this.pendingSessions = null;
    this.isWriting = true;

    const startTime = Date.now();

    try {
      // Ensure sessions directory exists
      await fs.promises.mkdir(this.sessionsDir, { recursive: true });

      // See saveSync: diagnostic on the full batch first, then short-circuit
      // only on drop-emptied batches.
      this.logSaveBatchSizeDiagnostic(pendingSessions);
      const writableInput = this.filterWritableSessions(pendingSessions, 'flush');
      if (writableInput.sessions.length === 0 && writableInput.droppedSessionIds.length > 0) return;

      const { sessions, forceChangedIds } = await this.prepareSessionsForPersistence(writableInput.sessions);
      const { changedSessions, newFingerprints } = this.computeUpserts(sessions, forceChangedIds);

      // Write changed session files with a bounded fan-out (defense-in-depth,
      // SESSION_STORE_FS_CONCURRENCY). Results are side effects into two Maps
      // keyed by id (order-independent).
      //
      // WRITE-FAILURE CONTRACT (must match the prior unbounded Promise.all):
      // `Promise.all(arr.map(mapper))` rejects on the first failing write, but a
      // bounded worker pool that simply lets a mapper throw is NOT equivalent —
      // when the first failure rejects `Promise.all(workers)`, the surviving
      // workers are orphaned: they keep draining the queue and writing files in
      // the BACKGROUND after the fan-out (and therefore flush()/save()) has
      // already settled. Because `save()` swallows the flush rejection
      // (`.catch(log)`), those late fire-and-forget writes can race a subsequent
      // flush or app-quit — the fs-races-past-completion hazard class behind
      // this store's data-safety incidents. So we catch per-session, let the
      // pool attempt+await EVERY changed session, then rethrow the first error
      // AFTER the fan-out. That preserves: (1) reject-fast-to-skip-index — the
      // throw still skips `writeIndex()`/fingerprint-cache below via flush()'s
      // try/catch; (2) all-attempted best-effort survival; (3) no orphaned
      // background writes (the function settles only once every write is done).
      // Reviewed + red→green tested: GPT-5.5 F1
      // (260617_195450_reviewer-gpt55-stage02.md).
      const stampedSessionsById = new Map<string, AgentSession>();
      let firstWriteError: unknown;
      await mapWithConcurrencyLimit(
        changedSessions,
        SESSION_STORE_FS_CONCURRENCY,
        async (session) => {
          try {
            const filePath = this.getSessionFilePath(session.id);
            const persisted = await this.persistSessionToDisk(filePath, session);
            stampedSessionsById.set(persisted.session.id, persisted.session);
            newFingerprints.set(persisted.session.id, this.computeFingerprint(persisted.session));
            log.debug(
              {
                sessionIdHash: hashSessionIdForBreadcrumb(session.id),
                sessionFileSizeMb: Number((Buffer.byteLength(persisted.json, 'utf8') / 1_000_000).toFixed(3)),
              },
              'Session file written',
            );
          } catch (writeError) {
            if (firstWriteError === undefined) firstWriteError = writeError;
            log.error(
              { sessionIdHash: hashSessionIdForBreadcrumb(session.id), err: writeError },
              'Session file write failed; continuing to attempt remaining changed sessions',
            );
          }
        },
      );
      // Any single write failure aborts the index/fingerprint update (the index
      // must never reference a session whose file write failed) — same outcome
      // as the prior Promise.all reject-fast, but only after every changed
      // session has been attempted and awaited.
      if (firstWriteError !== undefined) throw firstWriteError;
      const sessionsForIndex = sessions.map(
        (session) => stampedSessionsById.get(session.id) ?? session,
      );

      // Update index (UNION merge — preserves existing entries)
      await this.writeIndex(sessionsForIndex);

      // Update fingerprint cache (additive)
      for (const [id, fp] of newFingerprints) {
        this.cachedFingerprints.set(id, fp);
      }

      const duration = Date.now() - startTime;
      log.debug(
        {
          duration,
          totalSessions: sessions.length,
          changedCount: changedSessions.length,
        },
        'Async incremental save completed'
      );
    } catch (error) {
      log.error({ err: error, duration: Date.now() - startTime }, 'Async incremental save failed');
      throw error;
    } finally {
      this.isWriting = false;
    }
  }

  /**
   * Write index file asynchronously.
   * Updates in-memory index to keep it synchronized.
   */
  /**
   * Evict oldest DONE sessions if the index exceeds MAX_PERSISTED_SESSIONS.
   * Called before writing the index so the written index is already pruned.
   * ACTIVE sessions are never evicted; if all excess sessions are Active, the cap is exceeded.
   *
   * CRITICAL POLARITY: keep `isSessionActive(s)` (doneAt == null), evict only
   * `isSessionDone(s)` (doneAt != null). Inverting this would EVICT ACTIVE
   * sessions from disk — permanent data loss. Lifecycle is read through the
   * shared predicates, never raw `pinnedAt`/`doneAt` truthiness.
   *
   * MASS-LOSS BREAKER EXEMPTION (Stage 2 remover taxonomy): eviction is NOT
   * routed through guardRecoveryClassBulkRemoval(). It deliberately removes the
   * oldest (count − MAX_PERSISTED_SESSIONS) sessions — a count that can
   * legitimately exceed the breaker bound — and it carries its own invariant
   * (it may only ever remove sessions strictly OVER the cap, never more), so it
   * must not be subject to the recovery-class fraction bound. Pinned by test.
   */
  private evictIfNeeded(): void {
    if (sessionStoreReadOnlyMode) return;
    if (!this.index || this.index.sessions.length <= MAX_PERSISTED_SESSIONS) return;

    const overflow = this.index.sessions.length - MAX_PERSISTED_SESSIONS;
    const active = this.index.sessions.filter(s => isSessionActive(s));
    const done = this.index.sessions.filter(s => isSessionDone(s));

    // Sort Done sessions (the only eviction candidates) by updatedAt ascending (oldest first)
    done.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));

    const toEvict = done.slice(0, Math.min(overflow, done.length));

    if (toEvict.length < overflow) {
      log.warn(
        { total: this.index.sessions.length, active: active.length, cap: MAX_PERSISTED_SESSIONS },
        'Session count exceeds cap but all excess sessions are active — exceeding cap'
      );
    }

    const successfullyEvicted: string[] = [];
    for (const entry of toEvict) {
      try {
        this.softDeleteSessionFile(entry.id);
        this.cachedFingerprints.delete(entry.id);
        successfullyEvicted.push(entry.id);
      } catch (err) {
        // Soft-delete failed — keep the session in index/cache to stay consistent with disk
        log.error({ err, sessionId: entry.id }, 'Failed to evict session, keeping in index');
      }
    }

    const evictedIds = new Set(successfullyEvicted);
    this.index.sessions = this.index.sessions.filter(s => !evictedIds.has(s.id));

    if (toEvict.length > 0) {
      log.info(
        { evictedCount: toEvict.length, remaining: this.index.sessions.length },
        'Evicted oldest done sessions to stay within cap'
      );
    }
  }

  /**
   * SHARED by-construction backstop for EVERY index write that merges incoming
   * sessions into a base (writeIndex / writeIndexSync). Closes the class
   * "transient/unreadable primary read leaves this.index null → a writer
   * persists a SMALLER index over the healthy primary, hiding sessions"
   * (REBEL-1C8 round-4).
   *
   * Returns the base entries to merge into, or `'defer'` when writing now would
   * be unsafe. The ONLY job is to refuse a write when the in-memory base is null
   * AND the on-disk primary is NON-AUTHORITATIVELY unavailable (transiently
   * unreadable / newer-version) — because then `sessions` is, in general, only a
   * PARTIAL corpus and a base-less merge would shrink a healthy primary.
   *
   *  - `this.index` populated → authoritative in-memory base; use it.
   *  - `this.index` null → consult the shared transient-aware read:
   *    - 'transient' (EMFILE/IO) → DEFER: primary probably healthy but unreadable
   *      now; a base-less write would shrink it. Observable; caller skips.
   *    - 'version-forward' → newer app owns the data; DEFER (read-only).
   *    - 'ok' / 'version-backward' / 'absent' / 'corrupt' → base = [] (the
   *      EXISTING contract). Callers are EITHER: replace-style (load-prune /
   *      rebuild / legacy migration) that pass the AUTHORITATIVE full/loaded
   *      corpus and intend `sessions` to BECOME the index (the breaker guards
   *      legitimate shrinks), OR merge-style (doUpsertSession / migrate-from-
   *      agent-sessions) that establish their OWN authoritative base/defer
   *      upstream before calling here. We deliberately do NOT seed the base from
   *      a readable on-disk primary: that would UNION the stale on-disk rows back
   *      in and defeat the load-prune of missing-file entries.
   */
  private resolveAuthoritativeBaseForIndexWrite(
    context: SessionWriteGuardSource,
  ): { kind: 'proceed'; base: SessionIndexEntry[] } | { kind: 'defer'; reason: string } {
    if (this.index) {
      return { kind: 'proceed', base: this.index.sessions };
    }
    const read = this.readIndexFromDiskForUpsert();
    switch (read.status) {
      case 'transient': {
        sessionStoreSafetyCounters.indexWriteDeferredTransientBaseCount += 1;
        log.warn(
          {
            context,
            deferredCount: sessionStoreSafetyCounters.indexWriteDeferredTransientBaseCount,
          },
          'INDEX-WRITE DEFER: in-memory index is null AND the on-disk primary is transiently unreadable (EMFILE/IO); ' +
            'refusing to persist a base-less (shrunken) index over a probably-healthy primary — write skipped, disk untouched',
        );
        return { kind: 'defer', reason: 'transient-primary-read' };
      }
      case 'version-forward':
        sessionStoreSafetyCounters.reloadUpsertAbortedVersionForwardCount += 1;
        enterProtectiveReadOnlyMode(
          'reload-upsert-version-forward',
          'Index write found an on-disk index from a NEWER app version; deferring the write and entering read-only mode to protect data',
          { indexVersion: read.index.version, appIndexVersion: INDEX_VERSION },
        );
        return { kind: 'defer', reason: 'version-forward-index' };
      case 'ok':
      case 'version-backward':
      case 'absent':
      case 'corrupt':
        // Existing contract: empty base. Replace-style callers pass the full
        // authoritative corpus; merge-style callers establish their base/defer
        // upstream. Seeding from disk here would defeat load-prune (see doc).
        return { kind: 'proceed', base: [] };
    }
  }

  private async writeIndex(sessions: AgentSession[]): Promise<void> {
    if (sessionStoreReadOnlyMode) { log.warn('Session store in read-only mode, skipping writeIndex'); return; }

    // UNION semantics: merge incoming sessions into an AUTHORITATIVE base.
    // The shared guard never lets a transient/unreadable primary read collapse
    // the base to [] (which would shrink the on-disk index) — see
    // resolveAuthoritativeBaseForIndexWrite (REBEL-1C8 round-4 class fix).
    const baseResolution = this.resolveAuthoritativeBaseForIndexWrite('writeIndex');
    if (baseResolution.kind === 'defer') return;
    const existingEntries = baseResolution.base;
    const mergedMap = new Map(existingEntries.map(s => [s.id, s]));
    const writableIncoming = this.filterWritableSessions(sessions, 'writeIndex');
    // Stage 2 containment: build each entry under a per-session guard so one
    // malformed session can never abort the whole index rewrite (PLAN.md).
    const contained = { skipped: 0, corrupted: 0 };
    for (const session of writableIncoming.sessions) {
      const entry = this.buildContainedIndexEntry(session, 'writeIndex', contained);
      if (entry) mergedMap.set(entry.id, entry);
    }
    if (contained.corrupted > 0 || contained.skipped > 0) {
      log.warn(
        { context: 'writeIndex', corrupted: contained.corrupted, skipped: contained.skipped },
        'Index rewrite contained malformed sessions (degraded rows kept; unbuildable rows skipped)',
      );
    }
    // Sweep tombstoned ids out of the merged view (covers stale EXISTING
    // entries, not just the incoming batch).
    for (const id of Array.from(mergedMap.keys())) {
      if (this.isHardDeletedSessionId(id) && mergedMap.delete(id)) {
        this.recordTombstonedSessionWriteDrop(id, 'writeIndex');
      }
    }

    // Update in-memory index before eviction (evictIfNeeded reads this.index)
    this.index = {
      version: INDEX_VERSION,
      lastUpdated: Date.now(),
      sessions: Array.from(mergedMap.values()),
    };

    // Evict oldest Done sessions if over cap (keep Active sessions)
    this.evictIfNeeded();

    const json = JSON.stringify(this.index);
    await this.writeIndexFileAtomic(json);
  }

  /**
   * Write index file synchronously.
   * Updates in-memory index to keep it synchronized.
   */
  private writeIndexSync(sessions: AgentSession[]): void {
    if (sessionStoreReadOnlyMode) { log.warn('Session store in read-only mode, skipping writeIndexSync'); return; }

    // UNION semantics: merge incoming sessions into an AUTHORITATIVE base
    // (REBEL-1C8 round-4 class fix — see writeIndex()).
    const baseResolution = this.resolveAuthoritativeBaseForIndexWrite('writeIndexSync');
    if (baseResolution.kind === 'defer') return;
    const existingEntries = baseResolution.base;
    const mergedMap = new Map(existingEntries.map(s => [s.id, s]));
    const writableIncoming = this.filterWritableSessions(sessions, 'writeIndexSync');
    // Stage 2 containment: build each entry under a per-session guard so one
    // malformed session can never abort the whole index rewrite (PLAN.md).
    const contained = { skipped: 0, corrupted: 0 };
    for (const session of writableIncoming.sessions) {
      const entry = this.buildContainedIndexEntry(session, 'writeIndexSync', contained);
      if (entry) mergedMap.set(entry.id, entry);
    }
    if (contained.corrupted > 0 || contained.skipped > 0) {
      log.warn(
        { context: 'writeIndexSync', corrupted: contained.corrupted, skipped: contained.skipped },
        'Index rewrite contained malformed sessions (degraded rows kept; unbuildable rows skipped)',
      );
    }
    // Sweep tombstoned ids out of the merged view (see writeIndex()).
    for (const id of Array.from(mergedMap.keys())) {
      if (this.isHardDeletedSessionId(id) && mergedMap.delete(id)) {
        this.recordTombstonedSessionWriteDrop(id, 'writeIndexSync');
      }
    }

    // Update in-memory index before eviction (evictIfNeeded reads this.index)
    this.index = {
      version: INDEX_VERSION,
      lastUpdated: Date.now(),
      sessions: Array.from(mergedMap.values()),
    };

    // Evict oldest Done sessions if over cap (keep Active sessions)
    this.evictIfNeeded();

    const json = JSON.stringify(this.index);
    this.writeIndexFileAtomicSync(json);
  }

  /**
   * Create an AgentSessionSummary with all fields populated.
   * This is the canonical method for building index entries.
   * Normalizes turn state to fix stale isBusy/activeTurnId from persistence race conditions.
   */
  private createSummary(session: AgentSession): SessionIndexEntry {
    // Normalize turn state to ensure index shows correct busy status
    const normalized = normalizeSessionTurnState(session);

    // Pure field derivation (previews, usage, draft, meeting) via shared projection
    const projected = projectSessionSummaryFields(normalized);
    const derivedLiveness = deriveTurnLiveness(normalized.eventsByTurn, Date.now(), {
      declaredActiveTurnId: normalized.activeTurnId ?? null,
    });
    const summaryScalars = toPersistedBusyScalars(derivedLiveness);
    const summaryLastActivityAt = derivedLiveness.lastActivityAt ?? derivedLiveness.startedAt;

    return {
      id: normalized.id,
      title: normalized.title ?? null,
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
      cloudUpdatedAt: typeof normalized.cloudUpdatedAt === 'number' && Number.isFinite(normalized.cloudUpdatedAt)
        ? normalized.cloudUpdatedAt
        : undefined,
      resolvedAt: normalized.resolvedAt ?? null,
      // Canonical lifecycle field; populated by migratePinnedToDone() during
      // normalizeSessionTurnState above. See PLAN.md.
      doneAt: normalized.doneAt ?? null,
      starredAt: normalized.starredAt ?? null,
      deletedAt: normalized.deletedAt ?? null,
      origin: normalized.origin ?? 'manual',
      isCorrupted: false,
      privateMode: normalized.privateMode,
      interruptedTurnId: normalized.interruptedTurnId ?? null,
      // Spread projected fields (preview, usage, draft, meeting companion)
      ...projected,
      userMessageCount: countUserMessages(normalized),
      // Runtime status fields for lazy loading support (use normalized values)
      activeTurnId: summaryScalars.activeTurnId,
      isBusy: summaryScalars.isBusy,
      lastActivityAt: summaryLastActivityAt ?? null,
      lastError: normalized.lastError ?? null,
      maxSeq: typeof normalized.maxSeq === 'number' && Number.isInteger(normalized.maxSeq) && normalized.maxSeq > 0
        ? normalized.maxSeq
        : undefined,
      // Fingerprint for dirty tracking
      fingerprint: this.computeFingerprint(normalized),
    };
  }

  /**
   * Stage 2 containment (docs/plans/260616_folders-appear-empty-index-collapse/PLAN.md):
   * build a session's index entry, but never let one malformed session abort a
   * whole index rewrite. On a throw we PREFER surfacing over dropping: emit a
   * minimal `isCorrupted: true` entry built only from top-level scalars
   * (id/title/timestamps — no array access), so a corrupt conversation appears
   * as a degraded sidebar row rather than vanishing. If even that can't be built
   * safely (no usable id), we skip-with-log as the fallback.
   *
   * Observability per "silent failure is a bug": the per-session error is logged
   * once-per-session-per-process (deduped via a module Set to avoid log-storming
   * a rebuild over thousands of sessions), and the caller aggregates a count it
   * logs once per rebuild via `containedSessions.skipped`.
   */
  private buildContainedIndexEntry(
    session: AgentSession,
    context: SessionWriteGuardSource,
    contained: { skipped: number; corrupted: number },
  ): SessionIndexEntry | null {
    // Hard guard (260617): an entry with a non-string/empty id must NEVER enter
    // `this.index.sessions` — it would later crash `classifySessionKind(id)` in
    // listSessions(). The "no usable id" skip below already coerces a
    // non-string id to '' and skips, but make it explicit & future-proof against
    // ANY unanticipated session shape reaching here (not just today's paths).
    const rawId = (session as { id?: unknown }).id;
    if (typeof rawId !== 'string' || rawId.length === 0) {
      contained.skipped += 1;
      const key = `${context}:<non-string-id>`;
      if (!SUMMARY_BUILD_FAILED_LOGGED_SESSION_IDS.has(key)) {
        SUMMARY_BUILD_FAILED_LOGGED_SESSION_IDS.add(key);
        log.warn(
          { context, idType: typeof rawId },
          'Refusing to build an index entry for a session with a non-string/empty id — skipping so it cannot enter the index',
        );
      }
      return null;
    }
    try {
      return this.createSummary(session);
    } catch (err) {
      const sessionId = typeof session?.id === 'string' ? session.id : '';
      if (!SUMMARY_BUILD_FAILED_LOGGED_SESSION_IDS.has(sessionId || '<no-id>')) {
        SUMMARY_BUILD_FAILED_LOGGED_SESSION_IDS.add(sessionId || '<no-id>');
        log.error(
          { sessionId: sessionId || null, context, err },
          'Failed to build session index entry; containing to a degraded row (or skipping if unbuildable)',
        );
      }
      // Surface as a degraded row when we have a usable id. Use only top-level
      // scalar fields so this path itself cannot throw on the same bad data.
      if (sessionId) {
        contained.corrupted += 1;
        const createdAt = typeof session.createdAt === 'number' ? session.createdAt : 0;
        const updatedAt = typeof session.updatedAt === 'number' ? session.updatedAt : createdAt;
        const title = typeof session.title === 'string' ? session.title : null;
        // A corrupt session is definitionally not running. Compute non-busy
        // liveness scalars through the allowlisted summary boundary (same as
        // createSummary) rather than writing raw activeTurnId/isBusy — the
        // empty-eventsByTurn input short-circuits deriveTurnLiveness to idle and
        // cannot throw on the corrupt session's arrays.
        const corruptScalars = toPersistedBusyScalars(
          deriveTurnLiveness({}, Date.now(), { declaredActiveTurnId: null }),
        );
        return {
          id: sessionId,
          title,
          createdAt,
          updatedAt,
          resolvedAt: null,
          doneAt: typeof session.doneAt === 'number' ? session.doneAt : null,
          starredAt: typeof session.starredAt === 'number' ? session.starredAt : null,
          deletedAt: typeof session.deletedAt === 'number' ? session.deletedAt : null,
          origin: 'manual',
          isCorrupted: true,
          privateMode: session.privateMode === true,
          interruptedTurnId: null,
          preview: '',
          firstMessagePreview: '',
          messageCount: 0,
          hasUserMessages: false,
          userMessageCount: 0,
          hasDraft: false,
          draftPreview: null,
          draftUpdatedAt: null,
          usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
          activeTurnId: corruptScalars.activeTurnId,
          isBusy: corruptScalars.isBusy,
          lastActivityAt: null,
          lastError: null,
          fingerprint: `corrupted:${updatedAt}`,
        };
      }
      // No usable id → can't build a stable degraded row; skip just this session.
      contained.skipped += 1;
      ignoreBestEffortCleanup(err, {
        operation: `buildContainedIndexEntry.${context}`,
        reason: 'session index entry unbuildable and no usable id for a degraded row — skip this one session (failure logged above, aggregated via contained.skipped) so the rest of the index rewrite still completes',
      });
      return null;
    }
  }

  /**
   * Adopt a RECOVERED in-memory index built from the given loaded sessions,
   * WITHOUT writing to disk. Used by the read-only leg of the load/orphan-recovery
   * paths (F1): when recovery is needed but the store is read-only, we still want
   * `listSessions` to show the full recovered corpus this session rather than the
   * stale (possibly collapsed) on-disk index. Entries are built via the contained
   * builder so a single malformed session can't throw. The caller is responsible
   * for logging that the healed index could not be persisted.
   */
  private adoptRecoveredIndexInMemory(
    sessions: AgentSession[],
    context: SessionWriteGuardSource,
  ): void {
    const contained = { skipped: 0, corrupted: 0 };
    const mergedMap = new Map<string, SessionIndexEntry>();
    for (const session of sessions) {
      const entry = this.buildContainedIndexEntry(session, context, contained);
      if (entry) mergedMap.set(entry.id, entry);
    }
    if (contained.corrupted > 0 || contained.skipped > 0) {
      log.warn(
        { context, corrupted: contained.corrupted, skipped: contained.skipped },
        'Recovered in-memory index contained malformed sessions (degraded rows kept; unbuildable rows skipped)',
      );
    }
    this.index = {
      version: INDEX_VERSION,
      lastUpdated: Date.now(),
      sessions: Array.from(mergedMap.values()),
    };
  }

  /**
   * Load sessions from the new file-per-session format.
   * Handles v1→v2 index migration and orphan recovery.
   */
  private async loadFromNewFormat(): Promise<AgentSession[]> {
    const read = await this.readIndexFile(this.indexPath);
    if (read.kind === 'transient') {
      // Present-but-transiently-unreadable (EMFILE/IO) — NOT corruption. Throw a
      // TYPED sentinel so load()'s catch degrades (keeps in-memory index / empty)
      // instead of routing to .bak recovery → rebuild on a healthy index.
      throw new TransientIndexReadError(read.error);
    }
    // ENOENT here is unexpected (load() existence-checks first) but is genuinely
    // absent, not corrupt — let the rebuild-from-files path own it.
    const indexContent = read.kind === 'read' ? read.content : '';

    // 4-way validation (round-2 fix, review F1): a CURRENT-version index with
    // malformed rows is CORRUPT, exactly as on the reload-upsert path. Throwing
    // here routes it through load()'s catch — validated .bak recovery, then
    // rebuild-from-files fallback — instead of letting malformed rows masquerade
    // as missing-file prunes (or, over-bound, false-trip the mass-loss breaker).
    const validated = this.parseAndValidateIndex(indexContent);
    if (validated.status === 'corrupt') {
      throw new Error('index.json is corrupt (unparseable or malformed entries)');
    }
    const index = validated.index;

    // Forward-version protection: newer app wrote this index
    if (validated.status === 'version-forward') {
      enterProtectiveReadOnlyMode(
        'index-version-forward',
        'Session index from newer app version — entering read-only mode to protect data',
        { indexVersion: index.version, appIndexVersion: INDEX_VERSION },
      );
      // Still load sessions (read-only, not broken) — fall through to normal load path
    }

    // Check if index needs upgrade from v1 to v2 (enriched summaries)
    if (validated.status === 'version-backward') {
      log.info(
        { fromVersion: index.version, toVersion: INDEX_VERSION },
        'Index version outdated, rebuilding with enriched summaries'
      );
      return this.rebuildIndexFromFiles();
    }

    // Stage 3: tombstoned index entries are never adopted (delete-wins
    // visibility, always); the DISK cleanup (quarantine + index rewrite)
    // routes through the mass-loss breaker (rev-2, RS F14 — a >bound
    // tombstoned-row prune, e.g. after .bak recovery, trips read-only loudly
    // and preserves disk untouched).
    const tombstonePrune = this.filterWritableIndexEntries(index.sessions, 'loadFromNewFormat');
    if (tombstonePrune.removedIds.length > 0) {
      const quarantineAllowed = this.guardRecoveryClassBulkRemoval(
        tombstonePrune.removedIds.length,
        index.sessions.length,
        'loadFromNewFormat:tombstoned-index-prune',
      );
      index.sessions = tombstonePrune.entries;
      if (quarantineAllowed) {
        for (const id of tombstonePrune.removedIds) {
          await this.quarantineTombstonedActiveSessionFile(id, 'loadFromNewFormat');
        }
      }
    }

    // Bounded fan-out (defense-in-depth, SESSION_STORE_FS_CONCURRENCY). CRITICAL
    // semantics, preserved exactly: (1) result order matches index order
    // (mapWithConcurrencyLimit writes results[index]); the downstream filter and
    // index-entry ordering depend on it. (2) The per-entry try/catch->null is
    // what makes this load path NON-rejecting — a bad session file becomes a
    // skipped `null` (counted by missingCount), it does NOT abort the whole load
    // (the index-collapse incident class). The limiter does not intercept errors,
    // so copying the mapper verbatim preserves this.
    const sessions = await mapWithConcurrencyLimit(
      index.sessions,
      SESSION_STORE_FS_CONCURRENCY,
      async (entry) => {
        try {
          return await this.loadSessionFile(entry.id);
        } catch (error) {
          log.error({ sessionId: entry.id, err: error }, 'Failed to load session file');
          return null;
        }
      },
    );

    const validSessions = sessions.filter((s): s is AgentSession => s !== null);

    // Count index entries whose files failed to load BEFORE orphan recovery
    // appends extra sessions (orphan additions must not mask the prune size).
    const missingCount = index.sessions.length - validSessions.length;

    // Check for orphaned session files (written but not in index - crash recovery)
    const files = await fs.promises.readdir(this.sessionsDir);
    const sessionFileCount = files.filter(isSessionFile).length;
    const indexedIds = new Set(index.sessions.map((e) => e.id));
    const orphanFiles = files.filter(
      (f) => isSessionFile(f) && !indexedIds.has(f.replace('.json', ''))
    );

    // Check if we need to update index:
    // 1. Orphaned files found (not in index but exist on disk)
    // 2. Missing files (in index but couldn't load) - prevents "ghost" sessions in listSessions()
    // 3. Tombstoned entries pruned (Stage 3 delete-wins)
    const needsIndexUpdate =
      orphanFiles.length > 0 || missingCount > 0 || tombstonePrune.removedIds.length > 0;

    if (orphanFiles.length > 0) {
      log.warn({ orphanCount: orphanFiles.length }, 'Found orphaned session files, recovering');
      // Stage 3 fix round (review F2): tombstoned orphans are NEVER recovered
      // (delete-wins visibility, always), but their quarantine is a
      // recovery-class bulk disk mutation — partition them FIRST and route the
      // aggregate through the mass-loss breaker (Stage 2 remover taxonomy;
      // DEFERRAL §3's orphan-recovery mass-quarantine shape). On a trip the
      // stray files stay in place (read-only-preserve-everything).
      const tombstonedOrphanIds: string[] = [];
      const recoverableOrphanFiles: string[] = [];
      for (const file of orphanFiles) {
        const sessionId = file.replace('.json', '');
        if (this.isHardDeletedSessionId(sessionId)) {
          this.recordTombstonedSessionWriteDrop(sessionId, 'loadFromNewFormat');
          tombstonedOrphanIds.push(sessionId);
        } else {
          recoverableOrphanFiles.push(file);
        }
      }
      if (
        tombstonedOrphanIds.length > 0 &&
        this.guardRecoveryClassBulkRemoval(
          tombstonedOrphanIds.length,
          sessionFileCount,
          'loadFromNewFormat:tombstoned-orphan-quarantine',
        )
      ) {
        for (const sessionId of tombstonedOrphanIds) {
          await this.quarantineTombstonedActiveSessionFile(sessionId, 'loadFromNewFormat');
        }
      }
      for (const file of recoverableOrphanFiles) {
        const sessionId = file.replace('.json', '');
        try {
          const session = await this.loadSessionFile(sessionId);
          if (session) {
            validSessions.push(session);
            log.info({ sessionId }, 'Recovered orphaned session');
          }
        } catch (error) {
          log.error({ file, err: error }, 'Failed to recover orphaned session file');
        }
      }
    }

    if (missingCount > 0) {
      log.warn(
        { missingCount },
        'Pruning index entries for missing/corrupt session files'
      );
    }

    // MASS-LOSS CIRCUIT BREAKER (recovery-class): pruning more-than-bound index
    // entries in one load is a corruption symptom (stale/garbage index, mass
    // file loss), never a legitimate cleanup. Trip ⇒ read-only, keep the
    // on-disk index + files untouched. A persistent trigger re-trips at every
    // boot — intended and loud (see enterProtectiveReadOnlyMode()).
    if (
      missingCount > 0 &&
      !this.guardRecoveryClassBulkRemoval(missingCount, index.sessions.length, 'loadFromNewFormat')
    ) {
      this.index = index; // Preserve the full on-disk view (read-only now).
    } else if (needsIndexUpdate && !sessionStoreReadOnlyMode) {
      // Update index with recovered sessions and prune missing entries
      await this.writeIndex(validSessions);
    } else if (needsIndexUpdate) {
      // F1: recovery is needed (e.g. a collapsed index with recovered orphans)
      // but the store is read-only, so we can't persist. Still adopt the
      // RECOVERED in-memory index built from `validSessions` so listSessions
      // shows the full corpus THIS session — otherwise a read-only user keeps
      // seeing the truncated sidebar AND re-scans every startup. Disk write is
      // skipped. (Mirrors loadFromNewFormatSync.)
      log.warn(
        { recoveredCount: validSessions.length, indexedCount: index.sessions.length },
        'Recovered/healed session index could not be persisted (read-only mode) — adopting recovered index in memory for this session only',
      );
      this.adoptRecoveredIndexInMemory(validSessions, 'loadFromNewFormat');
    } else {
      // Store the loaded index in memory. Reached because nothing changed
      // (also the read-only tombstone-prune breaker-trip leg above is handled
      // separately): keep the in-memory view (already tombstone-pruned) without
      // touching disk.
      this.index = index;
    }

    // Build fingerprint cache. Skip sessions that were sanitized during
    // hydration so the dirty-detection in `findChangedSessions()` triggers a
    // persist on the next save and the on-disk repair completes.
    for (const session of validSessions) {
      if (isSessionSanitizedDuringHydration(session)) continue;
      this.cachedFingerprints.set(session.id, this.computeFingerprint(session));
    }

    log.info({ sessionCount: validSessions.length }, 'Loaded sessions from incremental store');
    return validSessions;
  }

  /**
   * Accept a hydrated file only if it is a real session payload: a session
   * always has a non-empty string `id`. A non-session sidecar (e.g. a
   * `cloud-*.json` / `folders.json` that slipped past the name-based
   * `isSessionFile()` denylist, or a genuinely-corrupt/partial-write file)
   * hydrates into an `id`-less object; accepting it poisons the index with an
   * `id: undefined` summary that later crashed `classifySessionKind(undefined)`
   * across sessions:list / time-saved / every agent turn. Skip it and surface
   * the skip *observably* (structured warn, never silent) so the cause is
   * debuggable. This makes "an id-less file becomes a session" impossible-by-
   * construction at the single read chokepoint, independent of the drift-prone
   * name denylist (sibling of the 260616 index-collapse hydration boundary).
   * See docs-private/investigations/260617_classifysessionkind_undefined_crash_handoff.md.
   */
  /**
   * Load a single session file, distinguishing ENOENT from parse/IO errors.
   *
   * - Returns the parsed (and normalized) session on success.
   * - Returns `null` when the file does not exist (ENOENT) — normal for a fresh
   *   session the renderer hasn't saved yet — OR when the file hydrates without a
   *   valid `id` (a non-session sidecar / corrupt payload), rejected *observably*
   *   by `verifyLoadedSessionFileId` so it can never poison the index.
   * - Throws on parse errors, permission errors, or other I/O failures so the
   *   caller can decide whether to fall back, abort, or surface the error.
   *
   * Used by `updateSession()` so a corrupt session file isn't silently
   * overwritten with a minimal "new" session.
   */
  /**
   * Close the filename-vs-content id gap (260617 crash root fix). A file in
   * `sessions/` that survives `isSessionFile()` (ends in `.json`, not in the
   * NON_SESSION_FILES allow-list) is ASSUMED to be a session, but its loaded
   * content might be a foreign/future sidecar with no `id` (or a different one).
   * Every legitimate session is written to `sessions/<session.id>.json` via
   * `getSessionFilePath(session.id)`, so a loaded session's `id` MUST be a
   * non-empty string equal to the filename-derived id. If not, treat the file as
   * NON-session: skip-with-observable-log so an undefined/mismatched id can never
   * enter the index (and later crash `classifySessionKind`). This future-proofs
   * against ANY unanticipated `*.json` in `sessions/`, not just today's
   * allow-list. Returns the session when valid, else `null`.
   */
  private verifyLoadedSessionFileId(
    session: AgentSession,
    filenameId: string,
    context: SessionWriteGuardSource,
  ): AgentSession | null {
    const loadedId = (session as { id?: unknown }).id;
    if (typeof loadedId === 'string' && loadedId.length > 0 && loadedId === filenameId) {
      return session;
    }
    // Two sub-cases, distinguished for observability: a missing/non-string id
    // (a non-session sidecar or corrupt payload), vs a present-but-mismatched id
    // (a foreign file whose content belongs to a different session). Both are
    // treated as NON-session and skipped so an undefined/mismatched id can never
    // enter the index (and later crash classifySessionKind).
    const hasNoValidId = typeof loadedId !== 'string' || loadedId.length === 0;
    const reason = hasNoValidId ? 'no-valid-id' : 'id-filename-mismatch';
    const key = `${context}:${filenameId}:${reason}`;
    if (!NON_SESSION_FILE_ID_MISMATCH_LOGGED.has(key)) {
      NON_SESSION_FILE_ID_MISMATCH_LOGGED.add(key);
      log.warn(
        {
          reason,
          filenameId,
          loadedIdType: typeof loadedId,
          context,
        },
        hasNoValidId
          ? 'Session file hydrated without a valid id — treating as a NON-session sidecar (or corrupt file) and skipping; it will not enter the index'
          : 'sessions/ file id does not match its filename — treating as a NON-session sidecar and skipping; it will not enter the index',
      );
    }
    return null;
  }

  private async loadSessionFileStrict(sessionId: string): Promise<AgentSession | null> {
    if (!this.isValidSessionId(sessionId)) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    // Stage 3 read chokepoint guard (kill-by-construction): a hard-deleted id
    // must be un-readable regardless of how a stray active file came to exist
    // (e.g. a migration source that re-created sessions/<id>.json before
    // writeIndex filtered it). Return null AND best-effort quarantine the
    // stray file so the tombstone wins over any leftover on-disk data. This is
    // the single async read path for a session file (loadSessionFile +
    // getSession + updateSession all route through here).
    if (this.isHardDeletedSessionId(sessionId)) {
      this.recordTombstonedSessionWriteDrop(sessionId, 'loadSessionFileStrict');
      await this.quarantineTombstonedActiveSessionFile(sessionId, 'loadSessionFileStrict');
      return null;
    }

    const filePath = this.getSessionFilePath(sessionId);
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      // Filename-vs-content id gap (260617): a foreign sidecar `*.json` that
      // slipped past isSessionFile() hydrates into a session with a
      // missing/mismatched id. Skip it so an undefined id never reaches the
      // index. Legitimate files always satisfy id === filename (every write uses
      // getSessionFilePath(session.id)).
      return this.verifyLoadedSessionFileId(
        hydrateSession(content),
        sessionId,
        'loadSessionFileStrict',
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * H2 (260621 monitoring): make a corrupt/unreadable (non-ENOENT) session-file
   * skip observable to the fleet instead of a silent null. Counts/operation
   * only — never the session id, path, or content (PII-safe by construction:
   * the known-condition's contextSchema is `.strict()` on {operation,
   * errorCode}). Best-effort; never throws into the lenient load path.
   */
  private reportCorruptSessionFile(
    operation: 'loadSessionFile' | 'loadSessionFileSync',
    err: unknown,
  ): void {
    try {
      const errorCode = (err as NodeJS.ErrnoException)?.code;
      captureKnownCondition(
        'corrupt_session_file_skipped',
        { extra: { operation, ...(errorCode ? { errorCode } : {}) } },
        err instanceof Error ? err : new Error(String(err)),
      );
    } catch (captureError) {
      // Telemetry must never break the lenient load; the warn already fired.
      log.debug({ err: captureError, operation }, 'corrupt-session-file capture failed');
    }
  }

  /**
   * Load a single session file.
   * Normalizes turn state to fix stale isBusy/activeTurnId from persistence race conditions.
   *
   * Lenient variant: returns `null` for ANY failure (ENOENT, parse errors,
   * permission errors). Use `loadSessionFileStrict()` when callers need to
   * distinguish "missing" from "unreadable".
   */
  private async loadSessionFile(sessionId: string): Promise<AgentSession | null> {
    if (!this.isValidSessionId(sessionId)) {
      log.warn({ sessionId }, 'Invalid session ID, skipping');
      return null;
    }

    try {
      return await this.loadSessionFileStrict(sessionId);
    } catch (err) {
      // H2 (260621 monitoring): loadSessionFileStrict already maps ENOENT → null
      // (a legitimately-absent file), so anything thrown here is a corrupt /
      // unparseable / unreadable session file — previously swallowed to a silent
      // null, which is exactly the kind of silent data-loss that needed the
      // user's .zip to diagnose. Make it observable (warn + Sentry) while
      // preserving the lenient null contract callers depend on.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        log.warn(
          { sessionId, err: err instanceof Error ? err.message : String(err) },
          'Skipped unreadable/corrupt session file (lenient load)',
        );
        this.reportCorruptSessionFile('loadSessionFile', err);
      }
      return null;
    }
  }

  /**
   * Rebuild index from session files (recovery path).
   */
  private async rebuildIndexFromFiles(): Promise<AgentSession[]> {
    const files = await fs.promises.readdir(this.sessionsDir);
    const sessionFiles = files.filter(isSessionFile).sort();

    const sessions: AgentSession[] = [];
    const tombstonedIds: string[] = [];

    for (const file of sessionFiles) {
      const sessionId = file.replace('.json', '');
      // Stage 3: a tombstoned id must never be rebuilt into the index
      // (delete-wins). Collected for a breaker-guarded quarantine below.
      if (this.isHardDeletedSessionId(sessionId)) {
        this.recordTombstonedSessionWriteDrop(sessionId, 'rebuildIndexFromFiles');
        tombstonedIds.push(sessionId);
        continue;
      }
      try {
        const session = await this.loadSessionFile(sessionId);
        if (session) {
          sessions.push(session);
          // Skip fingerprint seeding for sanitized sessions so the next save
          // persists the repair (parity with loadFromNewFormat).
          if (!isSessionSanitizedDuringHydration(session)) {
            this.cachedFingerprints.set(session.id, this.computeFingerprint(session));
          }
        }
      } catch (error) {
        log.error({ file, err: error }, 'Failed to load session file during recovery');
      }
    }

    // Stage 3: quarantine stray tombstoned files — breaker-guarded (RS F14).
    // On a trip the files stay in place (read-only-preserve-everything); the
    // tombstones still exclude them from the rebuilt sessions/index.
    if (
      tombstonedIds.length > 0 &&
      this.guardRecoveryClassBulkRemoval(
        tombstonedIds.length,
        sessionFiles.length,
        'rebuildIndexFromFiles:tombstoned-file-quarantine',
      )
    ) {
      for (const id of tombstonedIds) {
        await this.quarantineTombstonedActiveSessionFile(id, 'rebuildIndexFromFiles');
      }
    }

    // MASS-LOSS CIRCUIT BREAKER (recovery-class): if more-than-bound session
    // FILES exist but failed to load, writing the rebuilt index would silently
    // drop them from the visible corpus (the F2 shape). Trip ⇒ read-only,
    // preserve the on-disk state, return what loaded.
    const failedFileCount = sessionFiles.length - sessions.length - tombstonedIds.length;
    if (
      failedFileCount > 0 &&
      !this.guardRecoveryClassBulkRemoval(failedFileCount, sessionFiles.length, 'rebuildIndexFromFiles')
    ) {
      return sessions;
    }

    // Write reconstructed index
    await this.writeIndex(sessions);

    log.info({ sessionCount: sessions.length }, 'Rebuilt index from session files');
    return sessions;
  }

  /**
   * Migrate from legacy single-file format.
   */
  private async migrateFromLegacy(): Promise<AgentSession[]> {
    log.info('Migrating from legacy single-file format...');

    // Check for partial migration (sessions dir exists but legacy file still there).
    //
    // CATASTROPHE GUARD (Stage 2 item 3, DEFERRAL §4): this used to be an
    // unconditional recursive rm of sessions/. Reachable only with zero session
    // files TODAY, but sessions/ also holds folders.json and cloud outbox/meta
    // files (NON_SESSION_FILES) — and a future refactor could reach this with
    // live session files. Rename to a timestamped, recoverable backup instead;
    // never bulk-delete user data on a migration retry.
    if (fs.existsSync(this.sessionsDir) && fs.existsSync(this.legacyPath)) {
      const backupDir = `${this.sessionsDir}.partial-migration-${Date.now()}`;
      log.warn({ backupDir }, 'Partial migration detected - moving sessions/ to a recoverable backup and retrying');
      await fs.promises.rename(this.sessionsDir, backupDir);
      // Re-place files the fresh sessions/ must keep (see the constant's doc).
      if (PARTIAL_MIGRATION_PRESERVED_FILES.length > 0) {
        await fs.promises.mkdir(this.sessionsDir, { recursive: true });
        for (const filename of PARTIAL_MIGRATION_PRESERVED_FILES) {
          try {
            await fs.promises.copyFile(
              path.join(backupDir, filename),
              path.join(this.sessionsDir, filename),
            );
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              log.error({ err: getErrorMessage(err), filename }, 'Failed to re-place preserved file after partial-migration backup');
            }
          }
        }
      }
    }

    // Read legacy file
    const content = await fs.promises.readFile(this.legacyPath, 'utf8');
    const legacy = JSON.parse(content) as LegacySessionHistoryData;
    const sessions = legacy.sessions;
    const persistedSessions: AgentSession[] = [];

    // Create sessions directory
    await fs.promises.mkdir(this.sessionsDir, { recursive: true });

    // Write individual session files
    for (const session of sessions) {
      if (!this.isValidSessionId(session.id)) {
        log.warn({ sessionId: session.id }, 'Skipping session with invalid ID during migration');
        continue;
      }
      // Stage 3 write-side tombstone skip: never recreate sessions/<id>.json
      // for a hard-deleted id from a stale legacy source. The read chokepoint
      // would hide it, but skipping the write avoids leaving a stray file.
      if (this.isHardDeletedSessionId(session.id)) {
        this.recordTombstonedSessionWriteDrop(session.id, 'migrateFromLegacy');
        continue;
      }
      // Normalize BEFORE persisting so the legacy path honors the same
      // sanitized-persistence contract as the normal load path: the lifecycle
      // migration (migratePinnedToDone) derives `doneAt` and strips the legacy
      // `pinnedAt` key here, otherwise persistSessionToDisk would write the raw
      // `pinnedAt`-only session to sessions/<id>.json and seed its fingerprint.
      const normalized = normalizeSessionTurnState(session);
      const filePath = this.getSessionFilePath(normalized.id);
      const persisted = await this.persistSessionToDisk(filePath, normalized);
      this.cachedFingerprints.set(normalized.id, this.computeFingerprint(persisted.session));
      persistedSessions.push(persisted.session);
    }

    // Write index
    await this.writeIndex(persistedSessions);

    // Rename legacy file to backup (keeps as safety net)
    const backupPath = this.legacyPath.replace('.json', '.backup.json');
    await fs.promises.rename(this.legacyPath, backupPath);

    log.info({ sessionCount: persistedSessions.length }, 'Migration from legacy format complete');
    return persistedSessions;
  }

  /**
   * Load sessions from the new file-per-session format (sync version).
   * Handles v1→v2 index migration and orphan recovery.
   */
  private loadFromNewFormatSync(): AgentSession[] {
    const read = this.readIndexFileSync(this.indexPath);
    if (read.kind === 'transient') {
      // See loadFromNewFormat(): typed sentinel so loadSync()'s catch degrades
      // rather than rebuilding/recovering a possibly-healthy index.
      throw new TransientIndexReadError(read.error);
    }
    const indexContent = read.kind === 'read' ? read.content : '';

    // 4-way validation (round-2 fix, review F1) — see loadFromNewFormat():
    // malformed current-version rows are CORRUPT; throw so loadSync()'s catch
    // routes through validated .bak recovery → rebuild fallback.
    const validated = this.parseAndValidateIndex(indexContent);
    if (validated.status === 'corrupt') {
      throw new Error('index.json is corrupt (unparseable or malformed entries)');
    }
    const index = validated.index;

    // Forward-version protection: newer app wrote this index
    if (validated.status === 'version-forward') {
      enterProtectiveReadOnlyMode(
        'index-version-forward',
        'Session index from newer app version — entering read-only mode to protect data',
        { indexVersion: index.version, appIndexVersion: INDEX_VERSION },
      );
      // Still load sessions (read-only, not broken) — fall through to normal load path
    }

    // Check if index needs upgrade from v1 to v2 (enriched summaries)
    if (validated.status === 'version-backward') {
      log.info(
        { fromVersion: index.version, toVersion: INDEX_VERSION },
        'Index version outdated, rebuilding with enriched summaries (sync)'
      );
      return this.rebuildIndexFromFilesSync();
    }

    // Stage 3 tombstoned-entry prune — see loadFromNewFormat() (breaker-guarded
    // disk cleanup, RS F14; visibility prune always).
    const tombstonePrune = this.filterWritableIndexEntries(index.sessions, 'loadFromNewFormatSync');
    if (tombstonePrune.removedIds.length > 0) {
      const quarantineAllowed = this.guardRecoveryClassBulkRemoval(
        tombstonePrune.removedIds.length,
        index.sessions.length,
        'loadFromNewFormatSync:tombstoned-index-prune',
      );
      index.sessions = tombstonePrune.entries;
      if (quarantineAllowed) {
        for (const id of tombstonePrune.removedIds) {
          this.quarantineTombstonedActiveSessionFileSync(id, 'loadFromNewFormatSync');
        }
      }
    }

    const sessions: AgentSession[] = [];

    for (const entry of index.sessions) {
      try {
        const session = this.loadSessionFileSync(entry.id);
        if (session) {
          sessions.push(session);
        }
      } catch (error) {
        log.error({ sessionId: entry.id, err: error }, 'Failed to load session file');
      }
    }

    // Count index entries whose files failed to load BEFORE orphan recovery
    // appends extra sessions (orphan additions must not mask the prune size).
    const missingCount = index.sessions.length - sessions.length;

    // Check for orphaned session files (written but not in index - crash recovery)
    const files = fs.readdirSync(this.sessionsDir);
    const sessionFileCount = files.filter(isSessionFile).length;
    const indexedIds = new Set(index.sessions.map((e) => e.id));
    const orphanFiles = files.filter(
      (f) => isSessionFile(f) && !indexedIds.has(f.replace('.json', ''))
    );

    // Check if we need to update index:
    // 1. Orphaned files found (not in index but exist on disk)
    // 2. Missing files (in index but couldn't load) - prevents "ghost" sessions in listSessions()
    // 3. Tombstoned entries pruned (Stage 3 delete-wins)
    const needsIndexUpdate =
      orphanFiles.length > 0 || missingCount > 0 || tombstonePrune.removedIds.length > 0;

    if (orphanFiles.length > 0) {
      log.warn({ orphanCount: orphanFiles.length }, 'Found orphaned session files, recovering (sync)');
      // Stage 3 fix round (review F2) — sync mirror of loadFromNewFormat():
      // breaker-guard the aggregate tombstoned-orphan quarantine.
      const tombstonedOrphanIds: string[] = [];
      const recoverableOrphanFiles: string[] = [];
      for (const file of orphanFiles) {
        const sessionId = file.replace('.json', '');
        if (this.isHardDeletedSessionId(sessionId)) {
          this.recordTombstonedSessionWriteDrop(sessionId, 'loadFromNewFormatSync');
          tombstonedOrphanIds.push(sessionId);
        } else {
          recoverableOrphanFiles.push(file);
        }
      }
      if (
        tombstonedOrphanIds.length > 0 &&
        this.guardRecoveryClassBulkRemoval(
          tombstonedOrphanIds.length,
          sessionFileCount,
          'loadFromNewFormatSync:tombstoned-orphan-quarantine',
        )
      ) {
        for (const sessionId of tombstonedOrphanIds) {
          this.quarantineTombstonedActiveSessionFileSync(sessionId, 'loadFromNewFormatSync');
        }
      }
      for (const file of recoverableOrphanFiles) {
        const sessionId = file.replace('.json', '');
        try {
          const session = this.loadSessionFileSync(sessionId);
          if (session) {
            sessions.push(session);
            log.info({ sessionId }, 'Recovered orphaned session');
          }
        } catch (error) {
          log.error({ file, err: error }, 'Failed to recover orphaned session file');
        }
      }
    }

    if (missingCount > 0) {
      log.warn(
        { missingCount },
        'Pruning index entries for missing/corrupt session files (sync)'
      );
    }

    // MASS-LOSS CIRCUIT BREAKER (recovery-class) — see loadFromNewFormat().
    if (
      missingCount > 0 &&
      !this.guardRecoveryClassBulkRemoval(missingCount, index.sessions.length, 'loadFromNewFormatSync')
    ) {
      this.index = index; // Preserve the full on-disk view (read-only now).
    } else if (needsIndexUpdate && !sessionStoreReadOnlyMode) {
      // Update index with recovered sessions and prune missing entries
      this.writeIndexSync(sessions);
    } else if (needsIndexUpdate) {
      // F1: recovery is needed (e.g. a collapsed index with recovered orphans)
      // but the store is read-only, so we can't persist. Still adopt the
      // RECOVERED in-memory index built from `sessions` so listSessions shows
      // the full corpus THIS session — otherwise a read-only user keeps seeing
      // the truncated sidebar AND re-scans every startup. Disk write is skipped.
      log.warn(
        { recoveredCount: sessions.length, indexedCount: index.sessions.length },
        'Recovered/healed session index could not be persisted (read-only mode) — adopting recovered index in memory for this session only (sync)',
      );
      this.adoptRecoveredIndexInMemory(sessions, 'loadFromNewFormatSync');
    } else {
      // Store the loaded index in memory (no update needed — also the read-only
      // tombstone-prune breaker-trip leg: keep the pruned in-memory view, touch
      // nothing on disk).
      this.index = index;
    }

    // Build fingerprint cache (sync). Skip sanitized sessions so a stale
    // on-disk `running` status is rewritten on the next save.
    for (const session of sessions) {
      if (isSessionSanitizedDuringHydration(session)) continue;
      this.cachedFingerprints.set(session.id, this.computeFingerprint(session));
    }

    log.info({ sessionCount: sessions.length }, 'Loaded sessions from incremental store (sync)');
    return sessions;
  }

  /**
   * Load a single session file (sync version).
   * Normalizes turn state to fix stale isBusy/activeTurnId from persistence race conditions.
   */
  private loadSessionFileSync(sessionId: string): AgentSession | null {
    if (!this.isValidSessionId(sessionId)) {
      log.warn({ sessionId }, 'Invalid session ID, skipping');
      return null;
    }

    // Stage 3 read chokepoint guard — sync mirror of loadSessionFileStrict():
    // a hard-deleted id must be un-readable regardless of how a stray active
    // file was written.
    if (this.isHardDeletedSessionId(sessionId)) {
      this.recordTombstonedSessionWriteDrop(sessionId, 'loadSessionFileSync');
      this.quarantineTombstonedActiveSessionFileSync(sessionId, 'loadSessionFileSync');
      return null;
    }

    const filePath = this.getSessionFilePath(sessionId);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      // Filename-vs-content id gap (260617) — sync mirror of loadSessionFileStrict.
      return this.verifyLoadedSessionFileId(
        hydrateSession(content),
        sessionId,
        'loadSessionFileSync',
      );
    } catch (err) {
      // H2 (260621 monitoring) — sync mirror of loadSessionFile: ENOENT is a
      // legitimately-absent file (return null silently); any other failure is a
      // corrupt/unreadable session file that was previously swallowed to a
      // silent null. Make it observable while keeping the lenient null contract.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        log.warn(
          { sessionId, err: err instanceof Error ? err.message : String(err) },
          'Skipped unreadable/corrupt session file (lenient load, sync)',
        );
        this.reportCorruptSessionFile('loadSessionFileSync', err);
      }
      return null;
    }
  }

  /**
   * Rebuild index from session files (sync recovery path).
   */
  private rebuildIndexFromFilesSync(): AgentSession[] {
    const files = fs.readdirSync(this.sessionsDir);
    const sessionFiles = files.filter(isSessionFile);

    const sessions: AgentSession[] = [];
    const tombstonedIds: string[] = [];

    for (const file of sessionFiles) {
      const sessionId = file.replace('.json', '');
      // Stage 3: tombstoned ids never rebuild into the index (see async twin).
      if (this.isHardDeletedSessionId(sessionId)) {
        this.recordTombstonedSessionWriteDrop(sessionId, 'rebuildIndexFromFilesSync');
        tombstonedIds.push(sessionId);
        continue;
      }
      try {
        const session = this.loadSessionFileSync(sessionId);
        if (session) {
          sessions.push(session);
          // Skip fingerprint seeding for sanitized sessions so the next save
          // persists the repair (parity with loadFromNewFormatSync).
          if (!isSessionSanitizedDuringHydration(session)) {
            this.cachedFingerprints.set(session.id, this.computeFingerprint(session));
          }
        }
      } catch (error) {
        log.error({ file, err: error }, 'Failed to load session file during recovery');
      }
    }

    // Stage 3 breaker-guarded quarantine of stray tombstoned files (RS F14).
    if (
      tombstonedIds.length > 0 &&
      this.guardRecoveryClassBulkRemoval(
        tombstonedIds.length,
        sessionFiles.length,
        'rebuildIndexFromFilesSync:tombstoned-file-quarantine',
      )
    ) {
      for (const id of tombstonedIds) {
        this.quarantineTombstonedActiveSessionFileSync(id, 'rebuildIndexFromFilesSync');
      }
    }

    // MASS-LOSS CIRCUIT BREAKER (recovery-class) — see rebuildIndexFromFiles().
    const failedFileCount = sessionFiles.length - sessions.length - tombstonedIds.length;
    if (
      failedFileCount > 0 &&
      !this.guardRecoveryClassBulkRemoval(failedFileCount, sessionFiles.length, 'rebuildIndexFromFilesSync')
    ) {
      return sessions;
    }

    // Write reconstructed index
    this.writeIndexSync(sessions);

    log.info({ sessionCount: sessions.length }, 'Rebuilt index from session files (sync)');
    return sessions;
  }

  /**
   * Migrate from legacy single-file format (sync version).
   */
  private migrateFromLegacySync(): AgentSession[] {
    log.info('Migrating from legacy single-file format (sync)...');

    // Check for partial migration (sessions dir exists but legacy file still
    // there). CATASTROPHE GUARD — see migrateFromLegacy(): rename to a
    // timestamped, recoverable backup, never recursive rm.
    if (fs.existsSync(this.sessionsDir) && fs.existsSync(this.legacyPath)) {
      const backupDir = `${this.sessionsDir}.partial-migration-${Date.now()}`;
      log.warn({ backupDir }, 'Partial migration detected - moving sessions/ to a recoverable backup and retrying (sync)');
      fs.renameSync(this.sessionsDir, backupDir);
      // Re-place files the fresh sessions/ must keep (see the constant's doc).
      if (PARTIAL_MIGRATION_PRESERVED_FILES.length > 0) {
        fs.mkdirSync(this.sessionsDir, { recursive: true });
        for (const filename of PARTIAL_MIGRATION_PRESERVED_FILES) {
          try {
            fs.copyFileSync(path.join(backupDir, filename), path.join(this.sessionsDir, filename));
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              log.error({ err: getErrorMessage(err), filename }, 'Failed to re-place preserved file after partial-migration backup (sync)');
            }
          }
        }
      }
    }

    // Read legacy file
    const content = fs.readFileSync(this.legacyPath, 'utf8');
    const legacy = JSON.parse(content) as LegacySessionHistoryData;
    const sessions = legacy.sessions;
    const persistedSessions: AgentSession[] = [];

    // Create sessions directory
    fs.mkdirSync(this.sessionsDir, { recursive: true });

    // Write individual session files
    for (const session of sessions) {
      if (!this.isValidSessionId(session.id)) {
        log.warn({ sessionId: session.id }, 'Skipping session with invalid ID during migration');
        continue;
      }
      // Stage 3 write-side tombstone skip (sync mirror — see migrateFromLegacy).
      if (this.isHardDeletedSessionId(session.id)) {
        this.recordTombstonedSessionWriteDrop(session.id, 'migrateFromLegacySync');
        continue;
      }
      // Normalize BEFORE persisting so the legacy path honors the same
      // sanitized-persistence contract as the normal load path (see the async
      // migrateFromLegacy for the rationale): migratePinnedToDone derives
      // `doneAt` and strips the legacy `pinnedAt` key before the file write.
      const normalized = normalizeSessionTurnState(session);
      const filePath = this.getSessionFilePath(normalized.id);
      const persisted = this.persistSessionToDiskSync(filePath, normalized);
      this.cachedFingerprints.set(normalized.id, this.computeFingerprint(persisted.session));
      persistedSessions.push(persisted.session);
    }

    // Write index
    this.writeIndexSync(persistedSessions);

    // Rename legacy file to backup (keeps as safety net)
    const backupPath = this.legacyPath.replace('.json', '.backup.json');
    fs.renameSync(this.legacyPath, backupPath);

    log.info({ sessionCount: persistedSessions.length }, 'Migration from legacy format complete (sync)');
    return persistedSessions;
  }

  // ===========================================================================
  // Stage 0: Migration from agent-sessions/ directory
  // ===========================================================================

  /**
   * Migrate sessions from orphaned agent-sessions/ directory (async version).
   * This handles data from partial SessionStorageService implementation.
   */
  private async migrateFromAgentSessions(): Promise<void> {
    const startTime = Date.now();
    log.info('Checking for orphaned agent-sessions directory...');

    try {
      const files = await fs.promises.readdir(this.agentSessionsDir);
      const sessionFiles = files.filter((f) => f.endsWith('.json'));

      if (sessionFiles.length === 0) {
        // Empty directory - just rename and return
        const migratedPath = `${this.agentSessionsDir}.migrated`;
        await fs.promises.rename(this.agentSessionsDir, migratedPath);
        log.info('Empty agent-sessions directory renamed to .migrated');
        return;
      }

      // Ensure sessions directory exists
      await fs.promises.mkdir(this.sessionsDir, { recursive: true });

      // Load existing sessions index if it exists
      const existingIds = new Set<string>();
      const existingSessions: AgentSession[] = [];
      // Read the existing primary index via the SHARED transient-aware read.
      // A TRANSIENT (EMFILE/IO) read must NOT be silently swallowed and treated
      // as "no existing index" — that would make the migration's writeIndex base
      // (existingSessions) empty and risk shrinking a healthy primary. On
      // transient, DEFER the whole migration (return early, observable) and try
      // again on the next load; the writeIndex chokepoint is a second backstop.
      const existingRead = this.readIndexFileSync(this.indexPath);
      if (existingRead.kind === 'transient') {
        log.warn(
          'migrateFromAgentSessions: primary index transiently unreadable (EMFILE/IO) — DEFERRING migration this run (will retry next load); not treating the primary as missing/corrupt',
        );
        return;
      }
      if (existingRead.kind === 'read') {
        const validated = this.parseAndValidateIndex(existingRead.content);
        if (validated.status !== 'corrupt') {
          for (const entry of validated.index.sessions) {
            existingIds.add(entry.id);
            const session = await this.loadSessionFile(entry.id);
            if (session) existingSessions.push(session);
          }
        }
        // 'corrupt' → leave existingSessions empty; the migration writeIndex will
        // rebuild over the genuinely-broken primary (authoritative base []).
      }

      let migratedCount = 0;
      let skippedCount = 0;
      let overwrittenCount = 0;

      for (const file of sessionFiles) {
        try {
          const filePath = path.join(this.agentSessionsDir, file);
          const content = await fs.promises.readFile(filePath, 'utf8');
          // hydration-exempt: the id + hard-deleted-tombstone checks below must run
          // BEFORE normalize's side-effects (seq backfill / doneAt migration) so an
          // invalid/tombstoned session isn't re-materialized; normalizeSessionTurnState()
          // is applied to this rawSession further down before any use.
          const rawSession = JSON.parse(content) as AgentSession;

          if (!this.isValidSessionId(rawSession.id)) {
            log.warn({ file }, 'Invalid session ID in agent-sessions, skipping');
            skippedCount++;
            continue;
          }

          // Stage 3 write-side tombstone skip: a hard-deleted id present in
          // the agent-sessions migration source must NOT be re-materialized as
          // an active sessions/<id>.json. The read chokepoint would hide it,
          // but skipping the write avoids leaving a stray file for a later
          // orphan pass to clean up.
          if (this.isHardDeletedSessionId(rawSession.id)) {
            this.recordTombstonedSessionWriteDrop(rawSession.id, 'migrateFromAgentSessions');
            skippedCount++;
            continue;
          }

          // Normalize BEFORE the duplicate comparison/persist so the orphan
          // agent-sessions migration honors the same sanitized-persistence
          // contract as the legacy single-file path (see migrateFromLegacy):
          // migratePinnedToDone derives `doneAt` and strips the legacy
          // `pinnedAt` key here, otherwise persistSessionToDisk would write the
          // raw `pinnedAt`-only session to sessions/<id>.json. Safe before the
          // comparison: it reads only `id` (unchanged) and `updatedAt`.
          const session = normalizeSessionTurnState(rawSession);

          // Check for duplicate - compare against BOTH index and destination file
          // (destination file check handles case where index is missing/corrupt)
          const destPath = this.getSessionFilePath(session.id);
          let shouldWrite = true;
          const existingIdx = existingSessions.findIndex((s) => s.id === session.id);
          const isOverwriteCandidate = existingIds.has(session.id);

          if (isOverwriteCandidate) {
            // Found in index - compare updatedAt
            if (existingIdx >= 0 && existingSessions[existingIdx].updatedAt >= session.updatedAt) {
              skippedCount++;
              continue;
            }
          } else {
            // Not in index - but destination file might exist (index was corrupt/missing)
            // Check destination file directly to avoid overwriting newer data
            if (fs.existsSync(destPath)) {
              try {
                const existingContent = await fs.promises.readFile(destPath, 'utf8');
                // Loaded for use (pushed into existingSessions for index rebuild), so
                // full-hydrate through the boundary.
                const existingSession = hydrateSession(existingContent);
                if (existingSession.updatedAt >= session.updatedAt) {
                  // Existing file is newer - skip this migration
                  log.debug({ sessionId: session.id }, 'Skipping migration - destination file is newer');
                  skippedCount++;
                  shouldWrite = false;
                  // Still add to existingSessions for index rebuild
                  if (!existingIds.has(existingSession.id)) {
                    existingSessions.push(existingSession);
                    existingIds.add(existingSession.id);
                  } else {
                    const existingOnDiskIdx = existingSessions.findIndex(
                      (candidate) => candidate.id === existingSession.id,
                    );
                    if (existingOnDiskIdx >= 0) {
                      existingSessions[existingOnDiskIdx] = existingSession;
                    } else {
                      existingSessions.push(existingSession);
                    }
                  }
                  continue;
                }
              } catch {
                // Can't read destination - safe to overwrite
              }
            }
          }

          // Write to sessions/ directory
          if (shouldWrite) {
            const persisted = await this.persistSessionToDisk(destPath, session);
            const persistedSession = persisted.session;
            if (existingIdx >= 0) {
              existingSessions[existingIdx] = persistedSession;
            } else {
              existingSessions.push(persistedSession);
            }
            existingIds.add(persistedSession.id);
            if (isOverwriteCandidate) {
              overwrittenCount++;
            }
            migratedCount++;
          }
        } catch (err) {
          log.error({ err, file }, 'Failed to migrate session from agent-sessions');
          skippedCount++;
        }
      }

      // Update index with all sessions
      if (migratedCount > 0 || overwrittenCount > 0) {
        await this.writeIndex(existingSessions);
      }

      // Rename directory to mark as migrated (don't delete - safety net)
      const migratedPath = `${this.agentSessionsDir}.migrated`;
      await fs.promises.rename(this.agentSessionsDir, migratedPath);

      const duration = Date.now() - startTime;
      log.info(
        { duration, migratedCount, skippedCount, overwrittenCount, totalFiles: sessionFiles.length },
        'Migration from agent-sessions complete'
      );
    } catch (err) {
      log.error({ err }, 'Failed to migrate from agent-sessions directory');
      // Don't throw - allow normal loading to continue
    }
  }

  /**
   * Migrate sessions from orphaned agent-sessions/ directory (sync version).
   */
  private migrateFromAgentSessionsSync(): void {
    const startTime = Date.now();
    log.info('Checking for orphaned agent-sessions directory (sync)...');

    try {
      const files = fs.readdirSync(this.agentSessionsDir);
      const sessionFiles = files.filter((f) => f.endsWith('.json'));

      if (sessionFiles.length === 0) {
        const migratedPath = `${this.agentSessionsDir}.migrated`;
        fs.renameSync(this.agentSessionsDir, migratedPath);
        log.info('Empty agent-sessions directory renamed to .migrated');
        return;
      }

      // Ensure sessions directory exists
      fs.mkdirSync(this.sessionsDir, { recursive: true });

      // Load existing sessions index if it exists — via the SHARED
      // transient-aware read (see migrateFromAgentSessions()): a transient
      // EMFILE/IO read DEFERS the migration rather than treating the primary as
      // missing and shrinking it.
      const existingIds = new Set<string>();
      const existingSessions: AgentSession[] = [];
      const existingRead = this.readIndexFileSync(this.indexPath);
      if (existingRead.kind === 'transient') {
        log.warn(
          'migrateFromAgentSessionsSync: primary index transiently unreadable (EMFILE/IO) — DEFERRING migration this run (will retry next load); not treating the primary as missing/corrupt',
        );
        return;
      }
      if (existingRead.kind === 'read') {
        const validated = this.parseAndValidateIndex(existingRead.content);
        if (validated.status !== 'corrupt') {
          for (const entry of validated.index.sessions) {
            existingIds.add(entry.id);
            const session = this.loadSessionFileSync(entry.id);
            if (session) existingSessions.push(session);
          }
        }
      }

      let migratedCount = 0;
      let skippedCount = 0;
      let overwrittenCount = 0;

      for (const file of sessionFiles) {
        try {
          const filePath = path.join(this.agentSessionsDir, file);
          const content = fs.readFileSync(filePath, 'utf8');
          // hydration-exempt: the id + hard-deleted-tombstone checks below must run
          // BEFORE normalize's side-effects (seq backfill / doneAt migration) so an
          // invalid/tombstoned session isn't re-materialized; normalizeSessionTurnState()
          // is applied to this rawSession further down before any use.
          const rawSession = JSON.parse(content) as AgentSession;

          if (!this.isValidSessionId(rawSession.id)) {
            log.warn({ file }, 'Invalid session ID in agent-sessions, skipping');
            skippedCount++;
            continue;
          }

          // Stage 3 write-side tombstone skip (sync mirror — see async twin).
          if (this.isHardDeletedSessionId(rawSession.id)) {
            this.recordTombstonedSessionWriteDrop(rawSession.id, 'migrateFromAgentSessionsSync');
            skippedCount++;
            continue;
          }

          // Normalize BEFORE the duplicate comparison/persist (sync mirror — see
          // async migrateFromAgentSessions for the rationale): migratePinnedToDone
          // derives `doneAt` and strips legacy `pinnedAt` before the file write.
          const session = normalizeSessionTurnState(rawSession);

          // Check for duplicate - compare against BOTH index and destination file
          const destPath = this.getSessionFilePath(session.id);
          let shouldWrite = true;
          const existingIdx = existingSessions.findIndex((s) => s.id === session.id);
          const isOverwriteCandidate = existingIds.has(session.id);

          if (isOverwriteCandidate) {
            if (existingIdx >= 0 && existingSessions[existingIdx].updatedAt >= session.updatedAt) {
              skippedCount++;
              continue;
            }
          } else {
            // Not in index - check destination file directly
            if (fs.existsSync(destPath)) {
              try {
                const existingContent = fs.readFileSync(destPath, 'utf8');
                // Loaded for use (pushed into existingSessions for index rebuild), so
                // full-hydrate through the boundary.
                const existingSession = hydrateSession(existingContent);
                if (existingSession.updatedAt >= session.updatedAt) {
                  log.debug({ sessionId: session.id }, 'Skipping migration - destination file is newer');
                  skippedCount++;
                  shouldWrite = false;
                  if (!existingIds.has(existingSession.id)) {
                    existingSessions.push(existingSession);
                    existingIds.add(existingSession.id);
                  } else {
                    const existingOnDiskIdx = existingSessions.findIndex(
                      (candidate) => candidate.id === existingSession.id,
                    );
                    if (existingOnDiskIdx >= 0) {
                      existingSessions[existingOnDiskIdx] = existingSession;
                    } else {
                      existingSessions.push(existingSession);
                    }
                  }
                  continue;
                }
              } catch {
                // Can't read destination - safe to overwrite
              }
            }
          }

          if (shouldWrite) {
            const persisted = this.persistSessionToDiskSync(destPath, session);
            const persistedSession = persisted.session;
            if (existingIdx >= 0) {
              existingSessions[existingIdx] = persistedSession;
            } else {
              existingSessions.push(persistedSession);
            }
            existingIds.add(persistedSession.id);
            if (isOverwriteCandidate) {
              overwrittenCount++;
            }
            migratedCount++;
          }
        } catch (err) {
          log.error({ err, file }, 'Failed to migrate session from agent-sessions');
          skippedCount++;
        }
      }

      if (migratedCount > 0 || overwrittenCount > 0) {
        this.writeIndexSync(existingSessions);
      }

      const migratedPath = `${this.agentSessionsDir}.migrated`;
      fs.renameSync(this.agentSessionsDir, migratedPath);

      const duration = Date.now() - startTime;
      log.info(
        { duration, migratedCount, skippedCount, overwrittenCount, totalFiles: sessionFiles.length },
        'Migration from agent-sessions complete (sync)'
      );
    } catch (err) {
      log.error({ err }, 'Failed to migrate from agent-sessions directory (sync)');
    }
  }

  // ===========================================================================
  // Stage 2: Lazy Loading APIs
  // ===========================================================================

  /**
   * Return session summaries from in-memory index (no file I/O).
   * For lazy loading - enables fast sidebar display.
   * 
   * Note: The index is populated during load()/loadSync() which happens at app startup.
   * If called before load, returns empty array (with warning).
   * 
   * Note: Returns AgentSessionSummary (without fingerprint) to match IPC contract.
   *
   * Default behavior excludes delete-eligible internal sessions
   * (`memory-update-*`, `meeting-qa-*`, `error-eval-*`, `calendar-sync`) so user-facing
   * lists stay clean. Internal callers (cloud reconciliation, continuity,
   * diagnostics, indexing) should pass `{ includeInternal: true }`.
   */
  listSessions(options: ListSessionsOptions = {}): AgentSessionSummary[] {
    const { includeInternal = false } = options;
    // Stage 10: Try index-only load first (fast), fall back to full load if needed.
    // With lazy loading, sessions:list may be called before loadAgentSessions().
    //
    // On a TRANSIENT degrade that served a `.bak` EPHEMERALLY, this.index stays
    // null (write-safety invariant — see degradeOnTransientIndexRead) and we
    // derive summaries from the ephemeral index ONLY for this read.
    let ephemeralEntries: SessionIndexEntry[] | null = null;
    if (!this.index) {
      // Try index-only load first (~100x faster for users with many sessions)
      let indexOnlySuccess = false;
      let transientDegraded = false;
      try {
        indexOnlySuccess = this.loadIndexOnlySync();
      } catch (error) {
        // TRANSIENT index read (EMFILE/IO) — degrade rather than rebuild. NOT
        // corruption: disk untouched. degradeOnTransientIndexRead serves a good
        // `.bak` EPHEMERALLY (NOT adopted into this.index, so writers can't
        // persist it) — we derive summaries from that ephemeral index below. If
        // no `.bak`, the ephemeral index is null → [] for this call (the next
        // listSessions re-reads the real index). Crucially we do NOT fall back to
        // full loadSync — it would re-hit the transient read / rebuild.
        if (isTransientIndexReadError(error)) {
          const degraded = this.degradeOnTransientIndexRead(error, 'loadSync');
          ephemeralEntries = degraded.ephemeralIndex?.sessions ?? [];
          transientDegraded = true;
        } else {
          throw error;
        }
      }
      if (!indexOnlySuccess && !transientDegraded) {
        // Fall back to full load (handles migrations, crash recovery, etc.)
        log.info('listSessions: falling back to full loadSync');
        this.loadSync();
      }
    }
    // Derive from the ephemeral `.bak` entries when a transient degrade served
    // them; otherwise from this.index (which loadIndexOnlySync/loadSync may have
    // populated — read AFTER the guard block so TS widens it back from null).
    const sourceEntries: SessionIndexEntry[] = ephemeralEntries ?? this.index?.sessions ?? [];
    // Strip fingerprint to match AgentSessionSummary contract
    const summaries = sourceEntries
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- fingerprint destructured to strip it from the spread; not used directly
      .map(({ fingerprint, ...summary }) => summary);
    if (includeInternal) {
      return summaries;
    }
    return summaries.filter((summary) => !isSidebarHiddenSession(summary.id));
  }

  /**
   * Refresh existing index summaries from already-loaded sessions without
   * rewriting session JSON files.
   */
  async refreshSessionIndexSummaries(sessions: AgentSession[]): Promise<number> {
    if (sessionStoreReadOnlyMode) {
      log.warn('Session store in read-only mode, skipping refreshSessionIndexSummaries');
      return 0;
    }
    if (sessions.length === 0) return 0;

    const operation = this.writeQueue.then(async () => {
      if (!this.index) {
        // Transient-aware + validated read (see other index readers). A
        // transient/absent/corrupt read SKIPS the refresh (returns 0, no write) —
        // refresh only ever updates existing rows in place over an authoritative
        // index, so it never shrinks; but routing through the shared read gives
        // EMFILE retry + observability and refuses malformed rows into this.index.
        const read = await this.readIndexFile(this.indexPath);
        if (read.kind !== 'read') {
          log.warn(
            { readKind: read.kind },
            'refreshSessionIndexSummaries: index unavailable (absent/transient), skipping index-only refresh',
          );
          return 0;
        }
        // F5 (260617): route through the same validator as load/upsert instead
        // of a raw `JSON.parse(...) as SessionIndex`. A raw parse accepts
        // malformed current-version rows (e.g. an undefined/non-string id) into
        // `this.index`, which then crashes downstream `classifySessionKind`.
        // The validator's version-forward/backward variants still carry an
        // index; we only refuse the truly 'corrupt' shape here (the version
        // gates below already handle forward/backward).
        const validated = this.parseAndValidateIndex(read.content);
        if (validated.status === 'corrupt') {
          log.warn(
            'refreshSessionIndexSummaries: index.json is corrupt/malformed, skipping index-only refresh',
          );
          return 0;
        }
        this.index = validated.index;
      }

      if (this.index.version > INDEX_VERSION) {
        enterProtectiveReadOnlyMode(
          'index-version-forward',
          'refreshSessionIndexSummaries: newer index version detected, skipping index-only refresh',
          { indexVersion: this.index.version, appIndexVersion: INDEX_VERSION },
        );
        return 0;
      }

      if (this.index.version < INDEX_VERSION) {
        log.warn(
          { fromVersion: this.index.version, toVersion: INDEX_VERSION },
          'refreshSessionIndexSummaries: index version outdated, skipping partial refresh',
        );
        return 0;
      }

      // Stage 3 fix round (review F1): the raw-parsed (or stale in-memory)
      // index may carry tombstoned rows — prune them BEFORE building the
      // refresh map, so this writer can never preserve/rewrite a hard-deleted
      // row and the entriesById.has() gate below is structurally add-proof
      // (a tombstoned input id has no row to refresh) instead of relying on
      // callers having pruned via listSessions()/load() first.
      const tombstonePrune = this.filterWritableIndexEntries(
        this.index.sessions,
        'refreshSessionIndexSummaries',
      );
      if (tombstonePrune.removedIds.length > 0) {
        this.index = { ...this.index, sessions: tombstonePrune.entries };
      }

      const entriesById = new Map(this.index.sessions.map((entry) => [entry.id, entry]));
      let refreshed = 0;

      for (const session of sessions) {
        if (!this.isValidSessionId(session.id)) {
          log.warn({ sessionId: session.id }, 'refreshSessionIndexSummaries called with invalid session ID, skipping');
          continue;
        }
        if (!entriesById.has(session.id)) {
          log.debug({ sessionId: session.id }, 'refreshSessionIndexSummaries: session missing from index, skipping');
          continue;
        }
        // F3 containment: a malformed field must not throw the whole refresh.
        // On failure keep the EXISTING entry (don't drop a row that's already in
        // the index) — buildContainedIndexEntry returns a degraded row or null;
        // skip the refresh for this session if it can't even be built.
        const refreshContained = { skipped: 0, corrupted: 0 };
        const refreshedEntry = this.buildContainedIndexEntry(
          session,
          'refreshSessionIndexSummaries',
          refreshContained,
        );
        if (refreshedEntry) {
          entriesById.set(session.id, refreshedEntry);
          refreshed += 1;
        }
      }

      if (refreshed === 0) return 0;

      this.index = {
        version: this.index.version,
        lastUpdated: Date.now(),
        sessions: Array.from(entriesById.values()),
      };

      await this.writeIndexFileAtomic(JSON.stringify(this.index));
      return refreshed;
    });

    this.writeQueue = operation.then(() => undefined).catch((err) => {
      log.error({ err }, 'refreshSessionIndexSummaries failed');
    });

    return operation;
  }

  /**
   * Return all session IDs from in-memory index (no file I/O).
   * For deep search - enables iterating over sessions without loading full content.
   * 
   * Note: The index is populated during load()/loadSync() which happens at app startup.
   * If called before load, returns empty array (with warning).
   */
  getSessionIds(): string[] {
    if (!this.index) {
      log.warn('getSessionIds called before index loaded - returning empty array');
      return [];
    }
    return this.index.sessions.map((s) => s.id);
  }

  /**
   * One-shot startup cleanup for leaked ephemeral sessions.
   *
   * Scans session files directly from disk (not the filtered index), deletes
   * delete-eligible sessions via the existing `deleteSession()` path, and
   * optionally notifies callers so cloud tombstones can be enqueued.
   */
  async cleanupLeakedSessions(
    options: CleanupLeakedSessionsOptions = {},
  ): Promise<CleanupLeakedSessionsSummary> {
    if (cleanupInFlight) {
      return cleanupInFlight;
    }

    cleanupInFlight = this.cleanupLeakedSessionsInternal(options).finally(() => {
      cleanupInFlight = null;
    });

    return cleanupInFlight;
  }

  private async cleanupLeakedSessionsInternal(
    options: CleanupLeakedSessionsOptions = {},
  ): Promise<CleanupLeakedSessionsSummary> {
    const summary: CleanupLeakedSessionsSummary = {
      scanned: 0,
      deleted: 0,
      errors: 0,
      sampleDeletedIds: [],
      deferredBeyondCap: 0,
    };

    // Force an index load before deletions so doDeleteSession() can prune index
    // entries even if cleanup runs before any list/load call at startup.
    this.listSessions({ includeInternal: true });

    let files: string[];
    try {
      files = await fs.promises.readdir(this.sessionsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        log.info({ ...summary }, 'Leaked delete-eligible session cleanup complete');
        return summary;
      }
      summary.errors = 1;
      log.error({ err }, 'Failed to scan session directory for leaked-session cleanup');
      log.info({ ...summary }, 'Leaked delete-eligible session cleanup complete');
      return summary;
    }

    const sessionFiles = files.filter(isSessionFile).sort();
    summary.scanned = sessionFiles.length;

    // CAP-AND-CONTINUE (Stage 2 item 1, FMM C-15/C-19): this remover runs
    // one-shot at startup with no retry wake, so it must NEVER trip the
    // read-only breaker (that would be a permanent every-boot read-only loop).
    // Instead it deletes at most the bulk-removal bound per pass, emits loud
    // telemetry, and converges across subsequent startups. By construction it
    // never touches `sessionStoreReadOnlyMode` — pinned by test.
    const deleteEligibleIds = sessionFiles
      .map((file) => file.replace(/\.json$/, ''))
      .filter((sessionId) => isDeleteEligibleSession(sessionId));
    const perPassCap = computeBulkRemovalBound(sessionFiles.length);
    if (deleteEligibleIds.length > perPassCap) {
      summary.deferredBeyondCap = deleteEligibleIds.length - perPassCap;
      sessionStoreSafetyCounters.cleanupLeakedSessionsCapDeferrals += 1;
      log.warn(
        {
          eligibleCount: deleteEligibleIds.length,
          perPassCap,
          deferredBeyondCap: summary.deferredBeyondCap,
          capDeferrals: sessionStoreSafetyCounters.cleanupLeakedSessionsCapDeferrals,
        },
        'cleanupLeakedSessions: backlog exceeds the per-pass safety cap; deleting up to the cap and deferring the rest to a later startup',
      );
      getErrorReporter().captureMessage('cleanupLeakedSessions capped at bulk-removal bound', {
        level: 'warning',
        fingerprint: ['session-store-cleanup-leaked-capped'],
        extra: {
          eligibleCount: deleteEligibleIds.length,
          perPassCap,
          deferredBeyondCap: summary.deferredBeyondCap,
        },
      });
    }

    for (const sessionId of deleteEligibleIds.slice(0, perPassCap)) {
      try {
        await options.onSessionDeletedLocally?.(sessionId, {
          source: 'cleanupLeakedSessions',
        });

        // Intent: 'hygiene' (Stage 3 classification table) — startup
        // housekeeping of leaked internal sessions. Non-tombstoning keeps the
        // ledger small (C-13); a resurrected leaked internal is re-pruned next
        // startup (benign, self-healing). Tombstoning regenerated internal ids
        // was the round-1 authority bug.
        await this.deleteSession(sessionId, { intent: 'hygiene' });
        const wasDeleted = !(await this.sessionFileExists(sessionId));
        if (!wasDeleted) {
          throw new Error('Session file still present after cleanup delete');
        }
        summary.deleted += 1;
        if (summary.sampleDeletedIds.length < 5) {
          summary.sampleDeletedIds.push(sessionId);
        }
      } catch (err) {
        summary.errors += 1;
        log.warn(
          {
            sessionIdHash: hashSessionIdForBreadcrumb(sessionId),
            err: getErrorMessage(err),
          },
          'cleanupLeakedSessions: skipping session — durable delete intent or local delete failed',
        );
      }
    }

    log.info({ ...summary }, 'Leaked delete-eligible session cleanup complete');
    return summary;
  }

  /**
   * Stage 10: Load ONLY the index file, without loading session files.
   * 
   * This is ~100x faster than loadSync() for users with many sessions:
   * - index.json: ~100KB (metadata only)
   * - All session files: ~100MB (full content)
   * 
   * Falls back to full loadSync() if:
   * - Index file doesn't exist (fresh install or crash recovery)
   * - Index is corrupted/invalid
   * - Index version is outdated (needs migration)
   * - Legacy migration needed
   * 
   * The fingerprint cache is NOT seeded by this method since we don't load session files.
   * This means the first save after startup may write more sessions than necessary.
   * This is an acceptable tradeoff for ~100x faster startup.
   */
  private loadIndexOnlySync(): boolean {
    try {
      // Stage 0: Migrate any orphaned data from agent-sessions/ (partial SessionStorageService impl)
      // This is rare and requires full load to handle properly
      if (fs.existsSync(this.agentSessionsDir)) {
        log.info('loadIndexOnly: agent-sessions dir exists, falling back to full load');
        return false;
      }

      // Check if new format index exists
      if (!fs.existsSync(this.indexPath)) {
        // Index doesn't exist - might be fresh install, crash recovery, or legacy migration
        // Fall back to full load which handles these cases
        log.info('loadIndexOnly: index.json not found, falling back to full load');
        return false;
      }

      // Read and validate the index (round-2 fix, review F1): malformed
      // current-version rows must never be accepted into the in-memory index —
      // later writes would persist the corrupt shape. The 'corrupt' leg falls
      // back to the full load, whose validated-recovery routing (.bak →
      // rebuild) owns it.
      const read = this.readIndexFileSync(this.indexPath);
      if (read.kind === 'transient') {
        // Present-but-transiently-unreadable (EMFILE/IO) — NOT corruption.
        // Returning false would route to full loadSync() → rebuild on a healthy
        // index. Throw the typed sentinel so listSessions() degrades instead.
        throw new TransientIndexReadError(read.error);
      }
      if (read.kind === 'absent') {
        // Raced with a deletion between the existsSync check and the read —
        // genuinely absent now; full load owns fresh-install/crash recovery.
        log.info('loadIndexOnly: index.json vanished between checks, falling back to full load');
        return false;
      }
      const validated = this.parseAndValidateIndex(read.content);
      if (validated.status === 'corrupt') {
        log.warn('loadIndexOnly: index.json corrupt or has malformed entries, falling back to full load (validated recovery)');
        return false;
      }
      const index = validated.index;

      // Forward-version protection: newer app wrote this index
      if (validated.status === 'version-forward') {
        enterProtectiveReadOnlyMode(
          'index-version-forward',
          'Session index from newer app version — entering read-only mode to protect data',
          { indexVersion: index.version, appIndexVersion: INDEX_VERSION },
        );
        // Still load index (read-only, not broken) — fall through to normal path
      }

      // Check if index needs upgrade
      if (validated.status === 'version-backward') {
        log.info(
          { fromVersion: index.version, toVersion: INDEX_VERSION },
          'loadIndexOnly: index version outdated, falling back to full load'
        );
        return false;
      }

      // Stage 3 tombstoned-entry prune — BEFORE the startup corrector below,
      // so it can never re-persist a tombstoned session file. Visibility prune
      // always; disk cleanup (quarantine + pruned-index rewrite via the
      // guarded writeIndexFileAtomicSync chokepoint, RS F15 — the mined port
      // wrote this raw) is breaker-guarded (RS F14).
      const tombstonePrune = this.filterWritableIndexEntries(index.sessions, 'loadIndexOnlySync');
      if (tombstonePrune.removedIds.length > 0) {
        const quarantineAllowed = this.guardRecoveryClassBulkRemoval(
          tombstonePrune.removedIds.length,
          index.sessions.length,
          'loadIndexOnlySync:tombstoned-index-prune',
        );
        index.sessions = tombstonePrune.entries;
        index.lastUpdated = Date.now();
        if (quarantineAllowed) {
          for (const id of tombstonePrune.removedIds) {
            this.quarantineTombstonedActiveSessionFileSync(id, 'loadIndexOnlySync');
          }
          if (!sessionStoreReadOnlyMode) {
            this.writeIndexFileAtomicSync(JSON.stringify(index));
          }
        }
      }

      // Stage 3 collapse self-heal (docs/plans/260616_folders-appear-empty-index-collapse/PLAN.md):
      // a current-version ('ok') index is normally adopted as-is, but the fast
      // path has NO orphan scan — so a COLLAPSED-but-valid index (the reported
      // 67-entry-vs-~2,882-files incident) would otherwise be re-adopted forever.
      // Detect a gross collapse with a cheap directory-listing-only orphan count
      // (NO file reads — keeps the fast path fast) and fall through to the full
      // load, whose loadFromNewFormatSync orphan recovery repopulates the index.
      try {
        const files = fs.readdirSync(this.sessionsDir);
        const indexedIds = new Set(index.sessions.map((e) => e.id));
        let orphanCount = 0;
        let fileCount = 0;
        for (const file of files) {
          if (!isSessionFile(file)) continue;
          fileCount += 1;
          if (!indexedIds.has(file.replace('.json', ''))) orphanCount += 1;
        }
        if (orphanCount > SUSPECT_COLLAPSE_ORPHAN_THRESHOLD) {
          log.warn(
            { indexCount: index.sessions.length, orphanCount, fileCount },
            'loadIndexOnly: index appears collapsed (many on-disk sessions missing from index) — falling back to full load for orphan recovery',
          );
          // Fleet-level detection canary (Arbitrator ruling 260621,
          // docs/plans/260621_session-collapse-canary/PLAN.md). The log.warn above
          // is a Sentry breadcrumb, not an alert: a #3-style silent collapse
          // (260616: 67 entries while ~2,882 files on disk) self-heals here via the
          // full-load fallback but would otherwise be INVISIBLE to monitoring (0
          // Sentry events — found only by user report). The crash-during-load path
          // already captures at error (session-store-load-failed); this is its
          // no-crash valid-but-collapsed twin. warning-level (self-heals); the fleet
          // signal is this issue's event count. Counts only — never titles/paths/ids.
          captureKnownCondition(
            'session_index_collapse_detected',
            { extra: { indexCount: index.sessions.length, orphanCount, fileCount } },
            new Error('session index appears collapsed (many on-disk sessions missing from index)'),
          );
          return false;
        }
      } catch (err) {
        // A readdir failure here must not crash the fast path; fall through to
        // the full load (which re-attempts the same dir) rather than adopting an
        // unverified index. Observable, not silent.
        log.warn(
          { err },
          'loadIndexOnly: collapse-detection orphan scan failed, falling back to full load',
        );
        ignoreBestEffortCleanup(err, {
          operation: 'loadIndexOnlySync.collapseScan',
          reason: 'collapse-detection orphan scan failed — fall through to full load (which re-attempts the scan and recovers); logged above',
        });
        return false;
      }

      // Correct interrupted sessions on startup: loads affected session files,
      // sets interruptedTurnId, applies markSessionTurnsAsCompleted, writes back.
      // Also clears stale isBusy/activeTurnId from index entries.
      this.correctInterruptedSessionsOnStartup(index);

      // Success! Store the index in memory
      this.index = index;

      // Seed fingerprint cache from index entries (they already have fingerprints)
      for (const entry of index.sessions) {
        if (entry.fingerprint) {
          this.cachedFingerprints.set(entry.id, entry.fingerprint);
        }
      }

      log.info(
        { sessionCount: index.sessions.length },
        'Loaded session index (index-only mode, skipped loading session files)'
      );
      return true;
    } catch (error) {
      // A TRANSIENT index read must NOT be downgraded to "fall back to full
      // load" — that would rebuild a possibly-healthy index. Re-throw so
      // listSessions() degrades (keeps the in-memory index, no rebuild).
      if (isTransientIndexReadError(error)) {
        throw error;
      }
      log.warn({ err: error }, 'loadIndexOnly: failed to read index, falling back to full load');
      return false;
    }
  }

  /**
   * Correct interrupted sessions on startup.
   * 
   * For each index entry that had isBusy/activeTurnId set (stale runtime state),
   * loads the session file, sets interruptedTurnId, applies markSessionTurnsAsCompleted,
   * and writes the corrected session back to disk. Updates the index entries accordingly.
   * 
   * This is the single fix point that covers all startup paths:
   * - loadIndexOnlySync (primary) → corrections happen here
   * - loadAgentSessions (full load) → reads already-corrected files
   * - getSession (on-demand) → reads already-corrected files
   */
  private correctInterruptedSessionsOnStartup(index: SessionIndex): void {
    // Collect indices of affected entries
    const affectedIndices: number[] = [];
    for (let i = 0; i < index.sessions.length; i++) {
      const entry = index.sessions[i];
      // Stage 3: never rewrite a tombstoned session file (belt-and-braces —
      // loadIndexOnlySync prunes tombstoned entries before calling this).
      if (this.isHardDeletedSessionId(entry.id)) {
        this.recordTombstonedSessionWriteDrop(entry.id, 'correctInterruptedSessionsOnStartup');
        continue;
      }
      if (entry.isBusy || entry.activeTurnId) {
        affectedIndices.push(i);
      }
    }

    if (affectedIndices.length === 0) return;

    const correctedSessionIds: string[] = [];

    for (const i of affectedIndices) {
      const entry = index.sessions[i];
      const sessionPath = this.getSessionFilePath(entry.id);

      try {
        const content = fs.readFileSync(sessionPath, 'utf8');
        // Arrays-only hydration: this path applies its OWN startup interrupted-turn
        // correction below, so it must NOT be pre-empted by the full normalize — but
        // messages/eventsByTurn are coerced first — `messages` is already guarded in
        // countUserMessages, but coercing `eventsByTurn` lets the downstream
        // createSummary summarize a malformed session normally instead of as a
        // degraded/contained row (defense-in-depth at the boundary).
        const session = hydrateSessionArraysOnly(content);

        // Capture activeTurnId before correction clears it
        const originalActiveTurnId = session.activeTurnId;

        // Apply interrupted-turn correction (sets interruptedTurnId if no terminal
        // event, then clears activeTurnId/isBusy via markSessionTurnsAsCompleted).
        // 'startup-correction' = the previous process died without finalizing
        // (crash/kill) — discriminates from the graceful 'shutdown' path below.
        let correctedSession = originalActiveTurnId
          ? applyInterruptedTurnCorrection(session, originalActiveTurnId, 'startup-correction')
          : markSessionTurnsAsCompleted(session, 'startup-correction');

        // Write corrected session back to disk (skip in read-only mode)
        if (!sessionStoreReadOnlyMode) {
          correctedSession = this.persistSessionToDiskSync(sessionPath, correctedSession).session;
        }

        // Rebuild the index entry from the corrected session (always update in-memory)
        index.sessions[i] = this.createSummary(correctedSession);
        correctedSessionIds.push(entry.id);
      } catch (error) {
        // If session file can't be read, still clear the index entry flags
        log.warn(
          { err: error, sessionId: entry.id },
          'Failed to load session file for startup correction, clearing index flags only'
        );
        index.sessions[i] = { ...entry, isBusy: false, activeTurnId: null };
      }
    }

    // Persist corrected index (skip in read-only mode)
    index.lastUpdated = Date.now();
    if (!sessionStoreReadOnlyMode) {
      this.writeIndexFileAtomicSync(JSON.stringify(index));
    }

    log.info(
      { correctedCount: correctedSessionIds.length, correctedSessionIds },
      'Corrected interrupted sessions on startup'
    );
  }

  /**
   * Finalize sessions that still have activeTurnId/isBusy set during orderly shutdown.
   *
   * Unlike correctInterruptedSessionsOnStartup() (which sets interruptedTurnId for
   * crash recovery), this clears busy state WITHOUT marking sessions as interrupted.
   * The user chose to quit — these sessions don't need the "Pick Up Where You Left Off"
   * modal on next startup.
   *
   * After correction, locks the store read-only to prevent late-arriving renderer
   * IPC from overwriting the corrected state.
   *
   * Uses synchronous I/O to guarantee writes complete before app.exit().
   *
   * @see docs/plans/260426_fix_shutdown_persistence_race.md
   */
  finalizeActiveSessionsOnShutdown(): void {
    if (sessionStoreReadOnlyMode || isUserDataReadOnly()) return;

    // Ensure index is available (load from disk if not in memory) via the SHARED
    // transient-aware + validated read. A transient/unreadable/corrupt primary
    // SKIPS finalization (no write) rather than rewriting from a raw-parsed or
    // empty base — finalize only ever modifies entries in place over an
    // authoritative full index, never shrinks it.
    if (!this.index) {
      const read = this.readIndexFileSync(this.indexPath);
      if (read.kind === 'absent') return; // nothing to finalize
      if (read.kind === 'transient') {
        log.warn('finalizeActiveSessionsOnShutdown: primary index transiently unreadable (EMFILE/IO), skipping finalization');
        return;
      }
      const validated = this.parseAndValidateIndex(read.content);
      if (validated.status === 'corrupt') {
        log.warn('finalizeActiveSessionsOnShutdown: index corrupt/invalid, skipping finalization');
        return;
      }
      this.index = validated.index;
    }

    // Collect indices of affected entries
    const affectedIndices: number[] = [];
    for (let i = 0; i < this.index.sessions.length; i++) {
      const entry = this.index.sessions[i];
      // Stage 3: never rewrite a tombstoned session file on shutdown (the
      // raw index read above may predate an in-memory-only tombstone).
      if (this.isHardDeletedSessionId(entry.id)) {
        this.recordTombstonedSessionWriteDrop(entry.id, 'finalizeActiveSessionsOnShutdown');
        continue;
      }
      if (entry.isBusy || entry.activeTurnId) {
        affectedIndices.push(i);
      }
    }

    if (affectedIndices.length === 0) {
      // Lock store even when there's nothing to correct, to prevent
      // late-arriving renderer IPC from racing with shutdown.
      sessionStoreReadOnlyMode = true;
      return;
    }

    const correctedSessionIds: string[] = [];

    for (const i of affectedIndices) {
      const entry = this.index.sessions[i];
      const sessionPath = this.getSessionFilePath(entry.id);

      try {
        const content = fs.readFileSync(sessionPath, 'utf8');
        // Arrays-only hydration: this shutdown path applies its OWN turn-completion
        // correction below (no interruptedTurnId), so full normalize must not pre-empt
        // it — messages/eventsByTurn are coerced first — `messages` is already guarded in
        // countUserMessages, but coercing `eventsByTurn` lets the downstream
        // createSummary summarize a malformed session normally instead of as a
        // degraded/contained row (defense-in-depth at the boundary).
        const session = hydrateSessionArraysOnly(content);

        // Clear busy state WITHOUT setting interruptedTurnId.
        // markSessionTurnsAsCompleted clears activeTurnId/isBusy and appends
        // interruption status events for turns without terminal events. This is
        // the key semantic difference from startup correction: the user chose to
        // quit, so we don't want the resume modal on next startup.
        // 'shutdown' discriminates graceful quit from crash recovery in the
        // persisted status event (same user-facing copy).
        const correctedSession = this.persistSessionToDiskSync(
          sessionPath,
          markSessionTurnsAsCompleted(session, 'shutdown'),
        ).session;
        this.index.sessions[i] = this.createSummary(correctedSession);
        correctedSessionIds.push(entry.id);
      } catch (error) {
        // If session file can't be read, still clear the index entry flags so
        // the modal won't trigger on next startup based on stale index state.
        log.warn(
          { err: error, sessionId: entry.id, source: 'shutdown' },
          'Failed to finalize session on shutdown, clearing index flags only'
        );
        this.index.sessions[i] = { ...entry, isBusy: false, activeTurnId: null };
      }
    }

    // Persist corrected index and lock store.
    // try/finally ensures the read-only lock is set even if the index write fails
    // (e.g., full disk), preventing late renderer IPC from overwriting corrections.
    try {
      this.index.lastUpdated = Date.now();
      this.writeIndexFileAtomicSync(JSON.stringify(this.index));
    } finally {
      sessionStoreReadOnlyMode = true;
    }

    log.info(
      { correctedCount: correctedSessionIds.length, correctedSessionIds, source: 'shutdown' },
      'Finalized active sessions on shutdown'
    );
  }

  /**
   * Load a single session on demand.
   * For lazy loading - enables loading full session only when needed.
   */
  async getSession(id: string): Promise<AgentSession | null> {
    if (!this.isValidSessionId(id)) {
      log.warn({ sessionId: id }, 'Invalid session ID requested');
      return null;
    }
    const session = await this.loadSessionFile(id);
    // If lazy hydration sanitized an orphan running status, the index-only
    // fingerprint cache (seeded from listSessions/loadIndexOnly) reflects the
    // pre-sanitization state. Invalidate the cached entry so the next save
    // detects the repair as a change and persists the corrected JSON to disk.
    if (session && isSessionSanitizedDuringHydration(session)) {
      this.cachedFingerprints.delete(session.id);
    }
    return session;
  }

  /**
   * Check whether a session file exists on disk.
   * Returns false only for confirmed-missing files (ENOENT).
   * Returns true for permission errors or other unexpected failures
   * to prevent false ghost detection.
   */
  async sessionFileExists(sessionId: string): Promise<boolean> {
    try {
      const filePath = this.getSessionFilePath(sessionId);
      await fs.promises.access(filePath);
      return true;
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return false;
      }
      return true;
    }
  }

  /**
   * Save or update a single session.
   * Uses writeQueue to serialize with bulk save operations.
   * 
   * Returns a promise that rejects if THIS operation fails (unlike bulk save which swallows errors).
   * The queue continues processing subsequent operations even after a failure.
   */
  async upsertSession(session: AgentSession): Promise<void> {
    // Raw upsertSession callers keep the void contract, while truth-needing
    // consumers use upsertSessionWithOutcome() / updateSession() / the sync
    // upsert outcomes.
    await this.upsertSessionWithOutcome(session);
  }

  /**
   * Save or update a single session, reporting whether the write LANDED.
   *
   * Merge graft (260612 delete-wins collision, arbitration F4): cloud
   * consumers (cloudRouter pull-merge, cloudOutbox delta restamp) must only
   * advance side effects — broadcasts, push cursors, onSessionsSaved hooks —
   * when the local write actually happened. A tombstoned id is dropped inside
   * doUpsertSession (by construction — no caller-side guards) and reported as
   * 'dropped-tombstoned'; read-only mode reports 'dropped-read-only'.
   */
  async upsertSessionWithOutcome(session: AgentSession): Promise<SessionSingleUpsertOutcome> {
    if (sessionStoreReadOnlyMode) {
      log.warn('Session store in read-only mode, skipping upsertSession');
      return 'dropped-read-only';
    }
    // Chain this operation onto the queue.
    const operation = this.writeQueue.then(() => this.doUpsertSession(session));

    // Update queue to continue even if this operation fails (swallow for queue continuity)
    this.writeQueue = operation.then(
      () => undefined,
      (err) => {
        log.error({ err, sessionId: session.id }, 'Upsert failed');
      },
    );

    // Surface success/rejection of THIS specific operation to the caller.
    return await operation;
  }

  /**
   * Atomic read-modify-write for a single session.
   *
   * The ENTIRE read → mutate → write sequence runs inside the `writeQueue`,
   * so concurrent renderer saves cannot slip in between the read and the
   * write. This is the safe primitive for callers (like the turn-checkpoint
   * service) that need to merge changes into an existing session without
   * overwriting fields owned by other writers.
   *
   * Behaviour:
   * - Reads the current session from disk via `loadSessionFileStrict()`.
   *   Passes `null` to the mutator if the file doesn't exist (ENOENT).
   * - On parse / permission / I/O errors, the operation is aborted (no
   *   write) and the error is logged. We never overwrite a corrupt file
   *   with a minimal session.
   * - The mutator returns the new session, or `null` to abort the write.
   * - Errors are caught so they don't poison the queue for other callers.
   * - Read-only mode is honoured (no-op with a warning).
   */
  async updateSession(
    sessionId: string,
    mutator: (existing: AgentSession | null) => AgentSession | null,
  ): Promise<boolean> {
    if (sessionStoreReadOnlyMode) {
      log.warn({ sessionId }, 'Session store in read-only mode, skipping updateSession');
      return false;
    }

    if (!this.isValidSessionId(sessionId)) {
      log.warn({ sessionId }, 'updateSession called with invalid session ID, skipping');
      return false;
    }

    // Track whether the write actually succeeded so the caller can decide
    // whether to advance counters, notify cloud, etc.
    let writeSucceeded = false;

    // Chain the entire read-modify-write onto the queue. The .catch() ensures
    // a failure here cannot block subsequent queued writes.
    this.writeQueue = this.writeQueue
      .then(async () => {
        let existing: AgentSession | null;
        try {
          existing = await this.loadSessionFileStrict(sessionId);
        } catch (err) {
          // Parse / permission / I/O error: do NOT overwrite — the file may
          // be recoverable. ENOENT was handled by loadSessionFileStrict.
          log.error(
            { err, sessionId },
            'updateSession: failed to read session file, aborting (file may be corrupt)',
          );
          return;
        }

        let result: AgentSession | null;
        try {
          result = mutator(existing);
        } catch (err) {
          log.error({ err, sessionId }, 'updateSession: mutator threw, aborting');
          return;
        }

        if (!result) {
          // Mutator chose to abort — no write.
          return;
        }

        // doUpsertSession handles the file write, in-memory index update,
        // and fingerprint cache update. Stage 3: a tombstone-dropped write is
        // NOT success — consumers (automationScheduler, agentEventDispatcher
        // auto-title, cloudAutomationScheduler) must see `false`, exactly as
        // for any other non-persisted outcome.
        const upsertOutcome = await this.doUpsertSession(result);
        writeSucceeded = upsertOutcome === 'persisted';
      })
      .catch((err) => {
        log.error({ err, sessionId }, 'updateSession failed');
      });

    await this.writeQueue;
    return writeSucceeded;
  }

  async waitForIdle(): Promise<void> {
    await this.writeQueue;
  }

  /**
   * F1 (260617 round-2) — make the ASYNC single-upsert path as reload-safe as
   * the SYNC reload-upsert (upsertSessionsSyncInternal). When `this.index` is
   * null, reload the on-disk index BEFORE any caller initializes a one-row index
   * and writes it (which would clobber an intact index.json). Mirrors the sync
   * path's per-status decisions exactly via the shared readIndexFromDiskForUpsert:
   *
   *  - already in memory      → 'proceed' (no reload needed).
   *  - 'ok' / 'version-backward' → adopt the on-disk index into memory, 'proceed'
   *    (the caller merges the new summary in, then writes the FULL index).
   *  - 'absent' (ENOENT)      → 'proceed' with this.index left null; the caller's
   *    fresh one-row init is correct (genuine first write / empty store).
   *  - 'transient' (EMFILE/IO) → 'defer-transient': the on-disk index is probably
   *    healthy but unreadable now; the session FILE is already written, so SKIP
   *    the index write rather than shrink the corpus (orphan-recovery / next load
   *    repopulates). this.index stays null.
   *  - 'version-forward'      → newer app owns the data; enter read-only, 'read-only'.
   *  - 'corrupt'              → try .bak recovery (heals primary on disk); adopt
   *    on success ('proceed'); else enter read-only, 'read-only'.
   */
  private ensureIndexLoadedForUpsert(): 'proceed' | 'defer-transient' | 'read-only' {
    if (this.index) return 'proceed';

    const read = this.readIndexFromDiskForUpsert();
    switch (read.status) {
      case 'ok':
        this.index = read.index;
        // Seed fingerprint cache so the next save's change detection is accurate.
        for (const entry of read.index.sessions) {
          if (entry.fingerprint) this.cachedFingerprints.set(entry.id, entry.fingerprint);
        }
        return 'proceed';
      case 'version-backward':
        // An older-version index must be REBUILT from files here, NOT adopted
        // in memory — consistent with the load path (loadFromNewFormat* →
        // rebuildIndexFromFiles* on version-backward). Adopting it would let a
        // single-session upsert that races AHEAD of the first listSessions()
        // persist (and re-serve) the stale entries, leaving every OTHER session
        // un-migrated until the next restart — so a hydration-time migration
        // (e.g. migrateResolvedAutomationToDone, 260617) would silently not apply
        // to them. rebuildIndexFromFilesSync() re-hydrates every file (applying
        // the migration) and sets this.index to the current INDEX_VERSION via
        // writeIndexSync. If the mass-loss breaker trips it leaves this.index
        // null; defer the index write (the session FILE is already persisted, so
        // the next full load retries) rather than init a one-row index that would
        // mask the corpus.
        this.rebuildIndexFromFilesSync();
        return this.index ? 'proceed' : 'defer-transient';
      case 'absent':
        // Genuine first write — leave this.index null; one-row init is correct.
        return 'proceed';
      case 'transient':
        return 'defer-transient';
      case 'version-forward':
        sessionStoreSafetyCounters.reloadUpsertAbortedVersionForwardCount += 1;
        enterProtectiveReadOnlyMode(
          'reload-upsert-version-forward',
          'Async upsert found an index written by a NEWER app version; dropping the index write and entering read-only mode to protect data',
          { indexVersion: read.index.version, appIndexVersion: INDEX_VERSION },
        );
        return 'read-only';
      case 'corrupt': {
        const recovered = this.recoverIndexFromBackupSync();
        if (recovered) {
          this.index = recovered;
          for (const entry of recovered.sessions) {
            if (entry.fingerprint) this.cachedFingerprints.set(entry.id, entry.fingerprint);
          }
          return 'proceed';
        }
        sessionStoreSafetyCounters.reloadUpsertAbortedCorruptIndexCount += 1;
        enterProtectiveReadOnlyMode(
          'reload-upsert-corrupt-index',
          'ASYNC-UPSERT CORRUPT-INDEX ABORT: index.json is corrupt AND index.json.bak is unusable. ' +
            'Refusing to write a one-row index that would mask the existing corpus; entering read-only mode.',
          {},
        );
        return 'read-only';
      }
    }
  }

  /**
   * Internal upsert implementation (called within writeQueue).
   *
   * Stage 3 (rev-2, ruling 6 / GPT-gen F2): the dropped-write result
   * ORIGINATES HERE, not at the handler — `updateSession` returns false on a
   * drop instead of lying `true` to its consumers (automationScheduler
   * snapshot/finish-line seeding, agentEventDispatcher auto-title,
   * cloudAutomationScheduler).
   */
  private async doUpsertSession(session: AgentSession): Promise<SessionSingleUpsertOutcome> {
    if (this.isHardDeletedSessionId(session.id)) {
      this.recordTombstonedSessionWriteDrop(session.id, 'doUpsertSession');
      return 'dropped-tombstoned';
    }

    const prepared = await this.prepareSessionForPersistence(session);
    session = prepared.session;

    // Ensure sessions directory exists
    await fs.promises.mkdir(this.sessionsDir, { recursive: true });

    // Write session file after sanitizing image bytes covered by durable refs.
    const filePath = this.getSessionFilePath(session.id);
    const persisted = await this.persistSessionToDisk(filePath, session);
    session = persisted.session;
    const json = persisted.json;

    // F1 (260617 round-2): if there is NO in-memory index, do NOT blindly
    // init-one-row-and-write — that would OVERWRITE an intact on-disk index.json
    // with a single-row index (hiding all other sessions) when this.index is
    // null because an earlier startup load hit a TRANSIENT EMFILE and degraded
    // to null. Reload the on-disk index first via the SAME safe path the sync
    // reload-upsert uses (readIndexFromDiskForUpsert: absent/ok/transient/
    // corrupt/version-*), then mirror its decisions. The session FILE is already
    // written above, so deferring/aborting the INDEX write never loses data
    // (orphan-recovery / next full load picks it up).
    const reload = this.ensureIndexLoadedForUpsert();
    if (reload === 'defer-transient') {
      sessionStoreSafetyCounters.upsertDeferredTransientIndexReadCount += 1;
      log.warn(
        {
          sessionIdHash: hashSessionIdForBreadcrumb(session.id),
          deferredCount: sessionStoreSafetyCounters.upsertDeferredTransientIndexReadCount,
        },
        'doUpsertSession DEFER: on-disk index.json present but transiently unreadable (EMFILE/IO); ' +
          'session FILE written but INDEX write SKIPPED to avoid overwriting the intact index with a one-row index',
      );
      return 'dropped-transient-index';
    }
    if (reload === 'read-only') {
      // ensureIndexLoadedForUpsert already entered protective read-only mode
      // (corrupt-unrecoverable / version-forward) — drop the index write.
      return 'dropped-read-only';
    }

    // Update in-memory index. F3 containment: the session FILE is already
    // written above, so a malformed-field throw here must not abort the upsert
    // (the file would become an unindexed orphan, recovered on next full load).
    // Route through the contained builder — a corrupt session lands as a
    // degraded row.
    const upsertContained = { skipped: 0, corrupted: 0 };
    const summary = this.buildContainedIndexEntry(session, 'doUpsertSession', upsertContained);
    if (summary) {
      if (this.index) {
        const existingIdx = this.index.sessions.findIndex((s) => s.id === session.id);
        if (existingIdx >= 0) {
          this.index.sessions[existingIdx] = summary;
        } else {
          this.index.sessions.push(summary);
        }
        this.index.lastUpdated = Date.now();
      } else {
        // Initialize index with this session
        this.index = {
          version: INDEX_VERSION,
          lastUpdated: Date.now(),
          sessions: [summary],
        };
      }

      // Update fingerprint cache for consistency with bulk save
      this.cachedFingerprints.set(session.id, summary.fingerprint);

      // Write index file (via the single guarded chokepoint: backup-then-write)
      const indexJson = JSON.stringify(this.index);
      await this.writeIndexFileAtomic(indexJson);
    }

    log.debug(
      {
        sessionIdHash: hashSessionIdForBreadcrumb(session.id),
        sessionFileSizeMb: Number((Buffer.byteLength(json, 'utf8') / 1_000_000).toFixed(3)),
      },
      'Session upserted',
    );
    return 'persisted';
  }

  /**
   * Delete a single session.
   * Uses writeQueue to serialize with bulk save operations.
   *
   * Stage 3: `options.intent` is REQUIRED (delete-authority pattern) — see
   * {@link SessionDeleteIntent}. 'user-delete' writes the durable hard-delete
   * ledger (the id can never be resurrected by a stale write); 'hygiene'
   * prunes file+index exactly as before and never tombstones.
   *
   * Returns a promise that rejects if THIS operation fails (unlike bulk save which swallows errors).
   * The queue continues processing subsequent operations even after a failure.
   */
  async deleteSession(id: string, options: SessionDeleteOptions): Promise<void> {
    if (sessionStoreReadOnlyMode) { log.warn('Session store in read-only mode, skipping deleteSession'); return; }
    // Chain this operation onto the queue
    const operation = this.writeQueue.then(() => this.doDeleteSession(id, options.intent));

    // Update queue to continue even if this operation fails (swallow for queue continuity)
    this.writeQueue = operation.catch((err) => {
      log.error({ err, sessionId: id }, 'Delete failed');
    });

    // Return the operation promise so caller sees success/rejection for THIS specific operation
    return operation;
  }

  /**
   * Internal delete implementation (called within writeQueue).
   *
   * LOCK INTERACTION (rev-2, RS F10): deletes participate in NO cross-process
   * lock today, and Stage 3 deliberately does not add one — the
   * delete-vs-CLI-locked-upsert race window is the CLI's whole critical
   * section (not "razor-thin"), its outcome is benign (a transiently
   * re-written file), and it self-heals at the next load via the
   * read-chokepoint quarantine. Accepted residual.
   */
  private async doDeleteSession(id: string, intent: SessionDeleteIntent): Promise<void> {
    // Soft-delete session file FIRST - if this fails (e.g., Windows file lock),
    // we don't want to update the index (otherwise the file gets "recovered" on next load)
    const deletedTimestamp = await this.softDeleteSessionFileAsync(id);

    // Stage 3: record the tombstone for genuine deletion intent ONLY.
    // Soft-delete/Trash (deletedAt) never reaches deleteSession at all, and
    // 'hygiene' callers (leaked-session cleanup, ghost-prune, continuity GC)
    // must never tombstone — see SessionDeleteIntent.
    //
    // NEVER-FAIL-DELETE (item d): a ledger persist failure must not fail the
    // delete — protection degrades to today's behavior for this id (loudly).
    if (intent === 'user-delete') {
      try {
        await this.recordHardDeletedSessionId(id, deletedTimestamp ?? Date.now());
      } catch (err) {
        hardDeleteGuardCounters.ledgerWriteFailures += 1;
        log.error(
          {
            sessionIdHash: hashSessionIdForBreadcrumb(id),
            err: getErrorMessage(err),
            ledgerWriteFailures: hardDeleteGuardCounters.ledgerWriteFailures,
          },
          'Failed to persist hard-delete ledger entry — delete proceeds; resurrection protection for this id degrades to in-memory only for this process',
        );
      }
    }

    let assetStore: ReturnType<typeof getAssetStore> | null = null;
    try {
      assetStore = getAssetStore();
    } catch (err) {
      log.warn(
        {
          sessionIdHash: hashSessionIdForBreadcrumb(id),
          err: getErrorMessage(err),
        },
        'Skipping session asset soft-delete lifecycle move because AssetStore is not initialized',
      );
    }

    if (assetStore && typeof deletedTimestamp === 'number') {
      try {
        await assetStore.moveSessionAssetsToDeleted({
          sessionId: id,
          timestamp: deletedTimestamp,
        });
        log.debug(
          {
            sessionIdHash: hashSessionIdForBreadcrumb(id),
            timestamp: deletedTimestamp,
          },
          'Moved session asset folder to deleted path',
        );
      } catch (err) {
        recordAssetResolutionFailure({
          sessionId: id,
          reason: 'unknown',
          context: 'lifecycle',
          metadata: {
            operation: 'move-session-assets-to-deleted',
            error: getErrorMessage(err),
          },
          log,
        });
      }
    }

    // File deleted (or didn't exist) - now safe to update index
    if (this.index) {
      this.index.sessions = this.index.sessions.filter((s) => s.id !== id);
      this.index.lastUpdated = Date.now();

      // Write updated index (via the single guarded chokepoint: backup-then-write)
      const indexJson = JSON.stringify(this.index);
      await this.writeIndexFileAtomic(indexJson);
    }

    // Remove from fingerprint cache
    this.cachedFingerprints.delete(id);

    log.debug({ sessionId: id }, 'Session deleted');
  }

  /** Check if the store is in read-only mode (newer version protection). */
  isReadOnly(): boolean { return sessionStoreReadOnlyMode || isUserDataReadOnly(); }

  /** Set read-only mode (used by version marker on startup). */
  setReadOnlyMode(value: boolean): void { sessionStoreReadOnlyMode = value; }
}

// Singleton instance
let incrementalStoreInstance: IncrementalSessionStore | null = null;

export function getIncrementalSessionStore(): IncrementalSessionStore {
  if (!incrementalStoreInstance) {
    incrementalStoreInstance = new IncrementalSessionStore();
  }
  return incrementalStoreInstance;
}

// Re-export legacy interface for compatibility during transition
export interface SessionHistoryData {
  version: number;
  sessions: AgentSession[];
}
