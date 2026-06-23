/**
 * Cloud Router
 *
 * Intercepts IPC calls in the main process. When cloud mode is enabled and the
 * channel is in the allowlist, forwards the call to the cloud service on Fly
 * via HTTP/WS. Otherwise, passes through to the local handler.
 *
 * The key integration point is `registerHandler()` in `src/main/ipc/utils/registerHandler.ts`,
 * which wraps every IPC handler with a cloud routing check. This makes ALL handlers
 * cloud-aware with a single-file change.
 */

import type { BroadcastService } from '@core/broadcastService';
import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import { hasPendingLocalSessionDrain } from '@core/services/lockedSessionPersistence';
import { getMaxSeqFromSession, stampMissingEventSeq } from '@core/services/sessionSeqIndex';
import {
  consumeSettingsDriftEmissionDecision,
  createSettingsDriftEmissionCache,
  detectSettingsDrift,
} from '@core/services/diagnostics/settingsDriftDetector';
import type { CloudServiceClient as CloudServiceClientType } from './cloudServiceClient';
import type { SessionSingleUpsertOutcome } from '@core/services/incrementalSessionStore';
import type { AgentEvent, AgentSession, AppSettings, InboxItem } from '@shared/types';
import { CLOUD_ROUTABLE_CHANNELS, DUAL_WRITE_CHANNELS } from '@shared/cloudChannelPolicies';
import type { SafetyActivityLogCloudSyncState } from '@shared/ipc/channels/safetyActivityLog';
import { mergeLocalSettings, stripLocalSettings } from '@shared/cloudSettingsPolicy';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { hashSessionId } from '@shared/trackingTypes';
import { toDiagnosticContinuityTransition } from '@shared/diagnostics/continuityTransition';
import type { ContinuityStateMap } from '@core/services/continuity/continuityStateTypes';
import { getErrorMessage } from '@core/utils/getErrorMessage';
import {
  clearPendingCodexCloudClear,
  hasPendingCodexCloudClear,
  markPendingCodexCloudClear,
} from '@core/services/codexTokenStorage';
import {
  clearPendingManagedKeyCloudClear,
  hasPendingManagedKeyCloudClear,
  markPendingManagedKeyCloudClear,
} from '@main/services/openRouterTokenStorage';
import type { BlockSource, FileLocation } from '@rebel/shared';
import { isSessionActive, isSessionDone } from '@rebel/shared';
import { cloudFailureCooldown, type CloudSyncOutcome } from './cloudFailureCooldown';
import {
  isCloudServiceError,
  hasLocalOnlyTurns,
  localHasContentCloudLacks,
  mergeSessionTurns,
  resolvePulledTitle,
  stripConversationAnnotations,
} from './cloudRouterHelpers';
import { pushFullSessionWithCapabilityGate } from './cloudOutbox';
import { deriveSessionUpdatedAt } from '@shared/utils/conversationState';
import { getEventIdentity, isValidSeq } from '@shared/utils/eventIdentity';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { conversationScopeResolver } from '@core/services/externalConversation/conversationScopeResolver';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import type { FolderStoreData } from '@shared/ipc/schemas/folders';

// Lazy-loaded to avoid pulling `ws` (native module) into the critical startup path.
// registerHandler.ts imports cloudRouter at module level, so this must be lightweight.
async function loadCloudClient(): Promise<typeof import('./cloudServiceClient')> {
  return import('./cloudServiceClient');
}

// Lazy-loaded event channel (same reason — avoid ws in critical path)
let _eventChannel: typeof import('./cloudEventChannel').cloudEventChannel | null = null;

async function loadEventChannel(): Promise<typeof import('./cloudEventChannel').cloudEventChannel> {
  if (!_eventChannel) {
    const mod = await import('./cloudEventChannel');
    _eventChannel = mod.cloudEventChannel;
  }
  return _eventChannel;
}

const log = createScopedLogger({ service: 'cloudRouter' });
const cloudMemoryApprovalLocationWarned = new Map<string, boolean>();
const desktopSettingsDriftEmissionCache = createSettingsDriftEmissionCache();

/** How often to run periodic inbox sync (pull + push + tombstone cleanup). */
const INBOX_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const TOMBSTONE_RACE_ESCALATION_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// CLOUD_ROUTABLE_CHANNELS and DUAL_WRITE_CHANNELS are imported from
// @shared/cloudChannelPolicies (single source of truth for all cloud channel metadata).

function cloudSuccessOutcome(ok = 1): CloudSyncOutcome {
  return { ok, failed: 0, authFailures: 0 };
}

function cloudFailureOutcome(sampleError?: unknown): CloudSyncOutcome {
  const outcome: CloudSyncOutcome = { ok: 0, failed: 1, authFailures: 0 };
  if (sampleError !== undefined) {
    outcome.sampleError = sampleError;
  }
  return outcome;
}

/**
 * A pull that was abandoned because the connection changed (disconnect /
 * account switch) while it was in flight. Distinct from success AND failure:
 * the caller must NOT record a cooldown verdict or mark `firstPullCompleted`
 * for it — the sync neither verified cloud health nor confirmed a fault.
 */
function cloudSupersededOutcome(): CloudSyncOutcome {
  return { ok: 0, failed: 0, authFailures: 0, superseded: true };
}

function recordCloudFailure(sampleError?: unknown): void {
  cloudFailureCooldown.recordCooldownVerdict(cloudFailureOutcome(sampleError));
}

function addOutcomeFailure(outcome: CloudSyncOutcome, sampleError: unknown): void {
  outcome.failed += 1;
  if (outcome.sampleError === undefined) {
    outcome.sampleError = sampleError;
  }
}

/**
 * Reconcile the cloud folders document against the local store on a restore
 * (first-connect pull). Pure + side-effect free so it can be unit-tested
 * directly. See PLAN.md Amendments A7 (merge rule) + F1/F6/F7.
 *
 * Rules:
 *  - F6 merge: if local is empty/trivial (no folders AND no membership) ⇒ take
 *    the cloud document verbatim (the common fresh-machine restore). Otherwise
 *    union folder defs by `id` (cloud authoritative on `id` conflicts,
 *    local-only folders preserved) and merge membership (cloud authoritative,
 *    local-only rows preserved) — never silently drop folders the user created
 *    on the new machine before first sync.
 *  - F1/F7 prune: drop membership rows whose `sessionId` is NOT present locally
 *    (dangling memberships → ghost sidebar entries). Must run AFTER session
 *    upserts so members arriving in the same pull are counted as present.
 *    Folder definitions (incl. empty folders) are KEPT regardless — empty
 *    folders are valid (F2).
 */
export function reconcileRestoredFolders(args: {
  cloud: FolderStoreData;
  local: FolderStoreData;
  presentSessionIds: ReadonlySet<string>;
}): FolderStoreData {
  const { cloud, local, presentSessionIds } = args;

  const localIsTrivial =
    local.folders.length === 0 && Object.keys(local.membership).length === 0;

  let mergedFolders: FolderStoreData['folders'];
  let mergedMembership: FolderStoreData['membership'];

  if (localIsTrivial) {
    mergedFolders = [...cloud.folders];
    mergedMembership = { ...cloud.membership };
  } else {
    // Union folders by id — cloud authoritative on conflicts, local-only kept.
    const byId = new Map<string, FolderStoreData['folders'][number]>();
    for (const f of local.folders) byId.set(f.id, f);
    for (const f of cloud.folders) byId.set(f.id, f);
    mergedFolders = [...byId.values()];
    // Merge membership — cloud authoritative, local-only rows preserved.
    mergedMembership = { ...local.membership, ...cloud.membership };
  }

  // F1/F7 prune: drop membership rows referencing absent sessions. Keep folder
  // defs (empty folders survive — F2).
  const prunedMembership: FolderStoreData['membership'] = {};
  for (const [sessionId, folderId] of Object.entries(mergedMembership)) {
    if (presentSessionIds.has(sessionId)) {
      prunedMembership[sessionId] = folderId;
    }
  }

  return {
    version: 1,
    folders: mergedFolders,
    membership: prunedMembership,
  };
}

interface SessionTombstone {
  sessionId: string;
  deletedAt: number;
  deletedBy: 'desktop' | 'mobile' | 'cloud';
  ttlExpiresAt: number;
}

interface ParsedTombstonesResponse {
  tombstones: SessionTombstone[];
  serverNow?: number;
}

type CodexTokenPushSource = 'mutation' | 'sync';
/**
 * Relay source for the managed (Mindstone subscription) OpenRouter key.
 * - `mutation`: a desktop save/clear/revoke (a genuine, intentful change).
 * - `sync`: reconnect-driven re-push of the current stored key (may read null
 *   transiently — the destructive-null guard must NOT relay a clear in that case).
 */
type ManagedKeyPushSource = 'mutation' | 'sync';

function getSessionEventIdentities(session: AgentSession): Set<string> {
  const identities = new Set<string>();
  for (const [turnId, events] of Object.entries(session.eventsByTurn ?? {})) {
    for (const event of events) {
      identities.add(getEventIdentity(turnId, event));
    }
  }
  return identities;
}

export function restampLocalOnlyEventsAboveSeq(
  session: AgentSession,
  pulledIdentities: Set<string>,
  ceiling: number,
): { session: AgentSession; restampedCount: number } {
  let restampedCount = 0;
  const nextEventsByTurn: Record<string, AgentEvent[]> = { ...(session.eventsByTurn ?? {}) };

  for (const [turnId, events] of Object.entries(session.eventsByTurn ?? {})) {
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!isValidSeq(event.seq) || event.seq > ceiling) continue;
      if (pulledIdentities.has(getEventIdentity(turnId, event))) continue;
      if (!Array.isArray(nextEventsByTurn[turnId])) continue;
      if (nextEventsByTurn[turnId] === events) {
        nextEventsByTurn[turnId] = [...events];
      }
      const cloned = { ...event };
      delete cloned.seq;
      nextEventsByTurn[turnId][index] = cloned;
      restampedCount += 1;
    }
  }

  if (restampedCount === 0) {
    return { session, restampedCount: 0 };
  }

  return {
    session: stampMissingEventSeq({
      ...session,
      eventsByTurn: nextEventsByTurn,
      maxSeq: ceiling,
    }),
    restampedCount,
  };
}

function classifySavePathLocalOnlyIntent(args: {
  // `existingCloudPinnedAt` is the EXEMPT cloud-continuity pin (cloudPinnedAt), a
  // distinct concept from the session lifecycle Active/Done — left unchanged by the rename.
  existingCloudPinnedAt?: number;
  demoteBecauseDone: boolean;
  demoteBecauseDeleted: boolean;
}): 'user' | 'inferred' {
  const hasExplicitDoneSignal = args.demoteBecauseDone && typeof args.existingCloudPinnedAt === 'number';
  /**
   * Intent classification table for save-path demotions:
   * - deletedAt=true => 'user' (explicit user delete)
   * - done + prior cloudPinnedAt => 'user' (explicit user mark-done)
   * - all other heuristics (including done-only) => 'inferred' (safe default)
   */
  if (args.demoteBecauseDeleted || hasExplicitDoneSignal) {
    return 'user';
  }
  return 'inferred';
}

function warnCloudMemoryApprovalLocationFallbackOnce(params: {
  filePath: string;
  spaceName: string | undefined;
  coreDirectory: string | undefined;
  reason: 'outside-workspace' | 'resolver-error';
}): void {
  const key = `${params.reason}:${params.filePath}`;
  if (cloudMemoryApprovalLocationWarned.has(key)) {
    return;
  }
  cloudMemoryApprovalLocationWarned.set(key, true);
  log.warn(
    {
      filePath: params.filePath,
      spaceName: params.spaceName,
      coreDirectory: params.coreDirectory,
      reason: params.reason,
    },
    params.reason === 'outside-workspace'
      ? 'Cloud memory approval FileLocation fell back to outside-workspace'
      : 'Cloud memory approval FileLocation resolution failed; storing approval without location',
  );
}

// ---------------------------------------------------------------------------
// Channel → bridge endpoint mapping
// ---------------------------------------------------------------------------

interface BridgeEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path template. `:0` is replaced with args[0], `:1` with args[1], etc. */
  path: string;
  /** Index of the arg to use as the JSON body. undefined = no body. */
  bodyArgIndex?: number;
}

/**
 * Map cloud-routable channels to bridge HTTP endpoints.
 *
 * After Phase C cleanup, only `settings:update` uses a dedicated REST endpoint.
 * All other remaining channels (automations:upsert, automations:delete,
 * agent:tool-safety-response) use the generic /api/ipc/:channel endpoint.
 *
 * `health:check` is kept for internal use (auto-wake, connection verification).
 */
const CHANNEL_TO_ENDPOINT: Record<string, BridgeEndpoint | ((args: unknown[]) => BridgeEndpoint)> = {
  // Settings (dual-write)
  'settings:update': { method: 'PATCH', path: '/api/settings', bodyArgIndex: 0 },

  // Codex OAuth tokens (desktop → cloud sync)
  'codex:sync-tokens': { method: 'POST', path: '/api/codex/tokens', bodyArgIndex: 0 },

  // Health (internal, not in CLOUD_CHANNEL_POLICIES)
  'health:check': { method: 'GET', path: '/api/health' },
};

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

export interface CloudRouterConfig {
  getSettings: () => AppSettings;
}

// ---------------------------------------------------------------------------
// CloudRouter class
// ---------------------------------------------------------------------------

class CloudRouter {
  private config: CloudRouterConfig | null = null;
  private httpClient: CloudServiceClientType | null = null;
  private connectedCloudUrl: string | null = null;
  private connectedCloudToken: string | null = null;
  private broadcastService: BroadcastService | null = null;
  private wakeInProgress: Promise<boolean> | null = null;
  private saveSyncListener: ((...args: unknown[]) => void) | null = null;
  private toolApprovalInterceptor: ((approval: Record<string, unknown>) => void) | null = null;
  private memoryApprovalInterceptor: ((approval: Record<string, unknown>) => Promise<void> | void) | null = null;
  private lifecycleInterval: ReturnType<typeof setInterval> | null = null;
  /** Stored listener refs for workspace watcher cloud sync (CRITICAL: never use removeAllListeners). */
  private workspaceWatcherListeners: {
    fileAdded: (filePath: string) => void;
    fileChanged: (filePath: string) => void;
    fileRemoved: (filePath: string) => void;
  } | null = null;
  /** True once the first full pull sync completes. Guards lifecycle checks from running before cloud state is known. */
  private firstPullCompleted = false;

  /** Timestamp of last successful sync — defaults to 0 so first sync fetches all. Not persisted. */
  private lastSyncTimestamp: number = 0;
  /** Promise-based mutex: callers can await an in-progress sync instead of silently skipping. */
  private activeSyncPromise: Promise<CloudSyncOutcome> | null = null;
  /** Promise-based mutex for inbox sync (separate from session sync). */
  private activeInboxSyncPromise: Promise<CloudSyncOutcome> | null = null;
  /**
   * Monotonic connection generation. Incremented by `disconnect()` (and therefore
   * by every real `updateConnection()`, which disconnects first). A fire-and-forget
   * pull cascade captures the epoch at entry and re-checks it before applying any
   * store mutation — so a sync that began under a now-torn-down connection (e.g. the
   * user switched cloud accounts or signed out mid-pull) discards its results instead
   * of writing stale-account data into the local store. See
   * docs/plans/260618_cloudrouter-disconnect-race/PLAN.md.
   */
  private connectionEpoch = 0;
  /** Promise-based mutex for inbox push (prevents overlapping pushes from debounce + periodic + focus). */
  private activeInboxPushPromise: Promise<CloudSyncOutcome> | null = null;
  /** Timestamp of last onAppFocused() call for debounce. */
  private lastFocusedAt: number = 0;
  /** Last known cloud version for update detection via X-Rebel-Cloud-Version header. */
  private lastKnownCloudVersion: string | null = null;
  /** Interval timer for periodic continuity state map pushes. */
  private continuityPushInterval: ReturnType<typeof setInterval> | null = null;
  /** How often to push continuity state map to cloud (ms). */
  private static readonly CONTINUITY_PUSH_INTERVAL_MS = 60_000;
  /** Backed-off interval for continuity pushes when state is unchanged (ms). */
  private static readonly CONTINUITY_PUSH_BACKOFF_MS = 300_000;
  /** Number of consecutive unchanged cycles before backing off. */
  private static readonly CONTINUITY_BACKOFF_THRESHOLD = 3;
  /** Fingerprint of the last successfully pushed continuity state map. */
  private lastContinuityFingerprint: string | null = null;
  /** Consecutive cycles where the continuity push was skipped (unchanged). */
  private continuityUnchangedCycles = 0;
  /** Debounce timer for inbox push (local mutations → cloud). */
  private inboxPushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Debounce timer for inbox pull (cloud inbox:changed → local). */
  private inboxPullDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Interval timer for periodic inbox sync (belt-and-suspenders convergence). */
  private inboxSyncInterval: ReturnType<typeof setInterval> | null = null;
  /** Unsubscribe from onInboxStateChange for debounced push. */
  private unsubscribeInboxStateChange: (() => void) | null = null;
  /** Debounce timer for MCP config sync (desktop → cloud). */
  private mcpSyncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** In-memory dirty flag: set on push failure, retried on focus/reconnect. */
  private mcpConfigDirty = false;
  /** Promise-based mutex for MCP config push (prevents overlapping PUTs). */
  private mcpSyncInFlight: Promise<void> | null = null;
  /** Unsubscribe from onMcpConfigChanged for debounced push. */
  private unsubscribeMcpConfigChange: (() => void) | null = null;
  /** Cached cloud-mode-active flag to avoid calling getSettings() on every IPC invoke. */
  private cachedCloudModeActive = false;
  /** Locally known server tombstones (sessionId -> tombstone). */
  private knownSessionTombstones = new Map<string, SessionTombstone>();
  /** Throttle map for tombstone-race captureMessage escalation (per direction). */
  private lastTombstoneRaceEscalatedAt = new Map<string, number>();
  /** Warn-once guard for older tombstones endpoints that don't return serverNow. */
  private warnedMissingTombstoneServerNow = false;
  /** Warn-once guard for tombstones endpoint returning 404; mirrors warnedMissingTombstoneServerNow precedent. */
  private warnedTombstoneEndpointMissing = false;
  /** Session-scoped counter for 404 occurrences at /api/sessions/tombstones. */
  private tombstoneMissingCount = 0;
  /** Session-scoped counter for 429 rate-limit occurrences. */
  private tombstoneRateLimitedCount = 0;
  /** Timestamp of the most recent successful tombstone refresh. */
  private lastSuccessfulTombstoneSyncAt: number | null = null;
  /** Last observed local Codex token presence from push call inputs. */
  private lastObservedCodexTokensPresent: boolean | null = null;
  /** Last observed local managed-key presence from relay call inputs. */
  private lastObservedManagedKeyPresent: boolean | null = null;

  // -------------------------------------------------------------------------
  // Layer C — self-echo dedup for cloud session-changed events.
  // (260427_sidebar_concurrent_swap_groundup_fix.md)
  //
  // When the renderer saves a session locally we enqueue it to the cloud
  // outbox; the cloud accepts it, then replays a session-changed event back
  // over the WS event channel. That echo would re-broadcast
  // `cloud:sessions-synced` to the renderer, which wholesale-replaces
  // `sessionSummaries` and (without Layer A) clobbers in-memory state.
  //
  // We can't tell from the WS event itself whether it's our own echo or a
  // legitimate cross-device update, so we mark sessions we just pushed and
  // suppress the renderer broadcast only when (a) we recently pushed AND
  // (b) `syncSessionFromCloud` reports no actual local update — meaning
  // the cloud version matched what we already had.
  // -------------------------------------------------------------------------
  /** sessionId -> ts (ms) most recently enqueued for cloud upload from this process. */
  private recentlyPushedSessions = new Map<string, number>();
  /** TTL for self-echo suppression — windows wider than the typical WS round-trip. */
  private static readonly SELF_ECHO_TTL_MS = 5_000;
  /** GC cutoff for the recently-pushed map; loose multiple of TTL to avoid frequent sweeps. */
  private static readonly SELF_ECHO_GC_CUTOFF_MS = 10_000;

  private markRecentlyPushed(sessionId: string): void {
    const now = Date.now();
    this.recentlyPushedSessions.set(sessionId, now);
    // Cheap GC on every touch — keeps the map bounded without a separate timer.
    const cutoff = now - CloudRouter.SELF_ECHO_GC_CUTOFF_MS;
    for (const [k, t] of this.recentlyPushedSessions) {
      if (t < cutoff) this.recentlyPushedSessions.delete(k);
    }
  }

  private isRecentlyPushedByUs(sessionId: string): boolean {
    const t = this.recentlyPushedSessions.get(sessionId);
    return t !== undefined && Date.now() - t < CloudRouter.SELF_ECHO_TTL_MS;
  }

  /**
   * Upsert a session locally and report whether the write LANDED (merge graft,
   * 260612 delete-wins collision, arbitration F4): a delete-wins tombstone (or
   * read-only mode) drops the write inside the store, and side effects —
   * broadcasts, push cursors, onSessionsSaved hooks — must not advance for a
   * write that never happened. Adapted to OUR store outcome vocabulary
   * (SessionSingleUpsertOutcome); the optional probe keeps minimal test mocks
   * with only `upsertSession` working.
   */
  private async upsertSessionIfWritten(
    store: {
      upsertSessionWithOutcome?: (session: AgentSession) => Promise<SessionSingleUpsertOutcome>;
      upsertSession: (session: AgentSession) => Promise<void>;
    },
    session: AgentSession,
  ): Promise<AgentSession | null> {
    if (typeof store.upsertSessionWithOutcome === 'function') {
      const outcome = await store.upsertSessionWithOutcome(session);
      return outcome === 'persisted' ? session : null;
    }

    await store.upsertSession(session);
    return session;
  }

  private async upsertSessionsIfWritten(
    store: {
      upsertSessionWithOutcome?: (session: AgentSession) => Promise<SessionSingleUpsertOutcome>;
      upsertSession: (session: AgentSession) => Promise<void>;
    },
    sessions: AgentSession[],
  ): Promise<AgentSession[]> {
    const writtenSessions: AgentSession[] = [];
    for (const session of sessions) {
      const written = await this.upsertSessionIfWritten(store, session);
      if (written) {
        writtenSessions.push(written);
      }
    }
    return writtenSessions;
  }

  /**
   * Initialize with app dependencies. Called once at startup.
   */
  init(config: CloudRouterConfig): void {
    this.config = config;
    this.refreshCloudModeCache();
    log.info('Cloud router initialized');
  }

  /**
   * Refresh the cached cloud-mode-active flag from current settings.
   * Call this after settings changes that might affect cloud mode.
   */
  refreshCloudModeCache(): void {
    if (!this.config) {
      this.cachedCloudModeActive = false;
      return;
    }
    const settings = this.config.getSettings();
    const ci = settings.cloudInstance;
    this.cachedCloudModeActive = !!(ci && ci.mode === 'cloud' && ci.cloudUrl && ci.cloudToken);
  }

  private isCloudModeActive(): boolean {
    return this.cachedCloudModeActive;
  }

  private reportCloudConnectionSuccess(writer: 'focus' | 'post-drain' | 'router-success' | 'reconnect' | 'hourly-tick'): void {
    const cloudUrl = this.config?.getSettings().cloudInstance?.cloudUrl;
    import('./cloudConnectionReconcilerSingleton').then(({ cloudConnectionReconciler }) => {
      return cloudConnectionReconciler.reportSuccess({ writer, cloudUrl });
    }).catch((err) => {
      log.warn({ err, writer }, 'Failed to report cloud connection success');
    });
  }

  /**
   * Store a reference to the BroadcastService for agent event dispatch.
   * Called during app startup after the broadcast service is wired.
   */
  setBroadcastService(service: BroadcastService): void {
    this.broadcastService = service;
  }

  /**
   * TEST-ONLY: inject the HTTP client used by `getOrCreateClient()`.
   *
   * `getOrCreateClient()` lazy-builds the real `CloudServiceClient` from
   * settings, which is awkward to drive from a unit test that wants to assert
   * the request/response contract of a single pull. This seam lets a test
   * supply a stub client (typically with `get`/`put` mocks) so the pull path
   * can be exercised deterministically. Mirrors the `loadSessions`/`loadFolders`
   * injection points elsewhere. Not used by production code.
   */
  _setClientForTests(client: CloudServiceClientType | null): void {
    this.httpClient = client;
  }

  /**
   * Called after sessions are saved locally (via sessions:save or sessions:upsert).
   * Enqueues cloud_active sessions to the outbox for cloud delivery.
   * This is the primary mechanism for near-real-time desktop→cloud session sync.
   */
  onLocalSessionsSaved(sessions: Array<{ id?: string }>): void {
    if (!this.config) return;
    if (!this.shouldRouteToCloud('settings:update')) return; // cloud mode not active

    // Layer C: mark recently-pushed sessions SYNCHRONOUSLY, BEFORE the async
    // gap below. The cloud's WS echo can race ahead of our outbox enqueue
    // (especially across multiple in-flight saves), so marking after the await
    // would leave a window where the echo arrives unmarked and triggers a
    // wholesale broadcast. Marking here is conservative: we may include
    // sessions that ultimately aren't enqueued (done, deleted, empty),
    // but a spurious mark just expires harmlessly after the TTL.
    for (const s of sessions) {
      if (s && typeof s.id === 'string' && s.id.length > 0) {
        this.markRecentlyPushed(s.id);
      }
    }

    // Async — don't block the caller
    fireAndForget((async () => {
      try {
        const {
          isCloudActive,
          getContinuityEntry,
          markCloudActive,
          markLocalOnly,
          touchCloudActivity,
          flushContinuityMetadata,
        } = await import('./cloudContinuityMetadata');
        const { cloudOutbox } = await import('./cloudOutbox');

        // Demote sessions that are done, soft-deleted, or stale-empty.
        // The state map push (every 60s) signals the cloud to GC these sessions —
        // no outbox DELETE needed.
        let demoted = 0;
        for (const s of sessions) {
          if (!s || typeof s.id !== 'string') continue;
          if (!isCloudActive(s.id)) continue;
          const typed = s as { doneAt?: number | null; deletedAt?: number | null; messages?: unknown[] };
          const demoteBecauseDone = isSessionDone(typed);
          const demoteBecauseDeleted = Boolean(typed.deletedAt);
          const demoteBecauseHeuristicEmpty = Boolean(typed.messages && typed.messages.length === 0);
          const shouldDemote = demoteBecauseDone || demoteBecauseDeleted || demoteBecauseHeuristicEmpty;
          if (shouldDemote) {
            const entry = getContinuityEntry(s.id as string);
            const intent = classifySavePathLocalOnlyIntent({
              existingCloudPinnedAt: entry?.cloudPinnedAt,
              demoteBecauseDone,
              demoteBecauseDeleted,
            });
            markLocalOnly(s.id as string, 'cloud-disabled', intent);
            demoted++;
          }
        }
        // Flush demotions to disk immediately so they survive crashes
        if (demoted > 0) {
          await flushContinuityMetadata();
        }

        const cloudActiveSessions = sessions.filter((s) => {
          if (!s || typeof s.id !== 'string') return false;
          const typed = s as { doneAt?: number | null; deletedAt?: number | null; messages?: unknown[] };
          if (!isSessionActive(typed)) return false;
          if (typed.deletedAt) return false;
          if (typed.messages && typed.messages.length === 0) return false;
          // Already cloud_active: keep syncing (carries metadata updates to cloud)
          if (isCloudActive(s.id)) return true;
          // Auto-promote active sessions in continuity mode
          markCloudActive(s.id);
          return true;
        });

        if (cloudActiveSessions.length === 0) return;

        for (const s of cloudActiveSessions) {
          if (s.id) {
            cloudOutbox.enqueue(s.id, 'upsert');
            touchCloudActivity(s.id);
          }
        }

        this.drainOutbox().catch((err) => {
          log.warn({ err: (err as Error).message }, 'Outbox drain after local session save failed');
        });
      } catch (err) {
        log.warn({ err }, 'onLocalSessionsSaved failed');
      }
    })(), 'cloud.cloudRouter.line433');
  }

  /**
   * Called after a session is deleted locally (via sessions:delete).
   * If the session is cloud-known, enqueue a durable outbox delete and try an
   * immediate drain so cloud tombstones are created promptly.
   */
  async onLocalSessionDeleted(
    sessionId: string,
    options: { source?: 'cleanupLeakedSessions' } = {},
  ): Promise<void> {
    if (!this.config) return;
    if (!this.shouldRouteToCloud('settings:update')) return; // cloud mode not active

    const forceTombstone = options.source === 'cleanupLeakedSessions';
    const { getContinuityEntry, removeContinuityMetadata } = await import('./cloudContinuityMetadata');
    const entry = getContinuityEntry(sessionId);
    const isCloudKnown = !!entry && (
      entry.state === 'cloud_active'
      || typeof entry.lastCloudActivityAt === 'number'
      || typeof entry.cloudPinnedAt === 'number'
    );
    if (!forceTombstone && !isCloudKnown) return;

    const { removeCloudSyncMetadata } = await import('./cloudSyncMetadata');
    const { cloudOutbox } = await import('./cloudOutbox');
    removeCloudSyncMetadata(sessionId);
    removeContinuityMetadata(sessionId);
    // SAFETY: delete intent must be durable before we return; otherwise a crash
    // window can resurrect cloud sessions during the next pull.
    cloudOutbox.enqueue(sessionId, 'delete', { durable: true });

    if (forceTombstone) {
      getErrorReporter().addBreadcrumb({
        category: 'cleanup-tombstone-enqueued',
        message: 'cleanup-tombstone-enqueued',
        level: 'info',
        data: { sessionIdHash: hashSessionIdForBreadcrumb(sessionId) },
      });
    }

    this.drainOutbox().catch((err) => {
      log.warn({ err: (err as Error).message, sessionId }, 'Outbox drain after local session delete failed');
    });
  }

  /**
   * Check if a channel is dual-write (runs locally AND forwards to cloud).
   *
   * Dual-write channels keep local state in sync so switching back to
   * local mode doesn't lose data.
   */
  isDualWrite(channel: string): boolean {
    if (!this.isCloudModeActive()) return false;
    return DUAL_WRITE_CHANNELS.has(channel);
  }

  async syncSafetyActivityLogFromCloud(): Promise<{ cloudSyncState: SafetyActivityLogCloudSyncState }> {
    const eventChannel = await loadEventChannel();
    return eventChannel.syncSafetyActivityLogFromCloud();
  }

  /**
   * Check if a channel should be routed to the cloud.
   *
   * FAST: No async, no network calls. Just checks:
   * 1. Is cloud mode enabled in settings?
   * 2. Is this channel in the allowlist?
   */
  shouldRouteToCloud(channel: string): boolean {
    if (!this.isCloudModeActive()) return false;
    return CLOUD_ROUTABLE_CHANNELS.has(channel);
  }

  /**
   * Forward an IPC call to the bridge. Returns the result.
   *
   * After Phase C cleanup, only dual-write channels reach this method:
   * `settings:update` (REST), `agent:tool-safety-response` (generic IPC),
   * `automations:upsert` (generic IPC), `automations:delete` (generic IPC).
   */
  async forward(channel: string, args: unknown[]): Promise<unknown> {
    const client = await this.getOrCreateClient();
    if (!client) {
      return { error: { code: 'CLOUD_NOT_CONFIGURED', message: 'Cloud instance not configured' } };
    }

    if (!cloudFailureCooldown.isAvailable()) {
      log.debug({ channel }, 'Cloud forward skipped (failure cooldown active)');
      return { error: { code: 'CLOUD_COOLDOWN', message: 'Cloud temporarily unavailable (cooldown active)' } };
    }

    try {
      // Special case: settings:get — merge cloudInstance from local
      if (channel === 'settings:get') {
        return await this.forwardSettingsGet(client);
      }

      // Special case: settings:update — strip cloudInstance (tokens stay local)
      if (channel === 'settings:update') {
        return await this.forwardSettingsUpdate(client, args);
      }

      // Standard HTTP forwarding
      const result = await this.forwardHttp(client, channel, args);
      cloudFailureCooldown.recordCooldownVerdict(cloudSuccessOutcome());
      this.checkForCloudVersionChange();
      this.hydrateLocalMetadata(channel, result);
      if (result && typeof result === 'object' && !('error' in result)) {
        await this.runPostCloudHooks(channel, args);
      }
      return result;
    } catch (err) {
      if (isCloudServiceError(err)) {
        if (err.code === 'CLOUD_UNREACHABLE' || err.code === 'TIMEOUT') {
          recordCloudFailure(err);
          this.checkAutoRecovery();
          // Auto-wake: the Fly Machine may be stopped. A request wakes it automatically.
          log.warn({ channel, code: err.code }, 'Bridge unreachable, attempting auto-wake');
          const woke = await this.autoWake();
          if (woke) {
            log.info({ channel }, 'Auto-wake succeeded, retrying forward');
            try {
              if (channel === 'settings:get') return await this.forwardSettingsGet(client);
              if (channel === 'settings:update') return await this.forwardSettingsUpdate(client, args);
              const retryResult = await this.forwardHttp(client, channel, args);
              cloudFailureCooldown.recordCooldownVerdict(cloudSuccessOutcome());
              this.checkForCloudVersionChange();
              this.hydrateLocalMetadata(channel, retryResult);
              if (retryResult && typeof retryResult === 'object' && !('error' in retryResult)) {
                await this.runPostCloudHooks(channel, args);
              }
              return retryResult;
            } catch (retryErr) {
              recordCloudFailure(retryErr);
              this.checkAutoRecovery();
              log.error({ err: retryErr, channel }, 'Retry after auto-wake also failed');
            }
          }

          return {
            error: {
              code: 'CLOUD_UNAVAILABLE',
              message: 'Cloud instance is unavailable. It may be sleeping or unreachable.',
            },
          };
        }

        recordCloudFailure(err);
        this.checkAutoRecovery();
        log.error({ err, channel, code: err.code }, 'Cloud bridge error during forward');
        return {
          error: { code: err.code, message: err.message },
        };
      }

      log.error({ err, channel }, 'Unexpected error forwarding to cloud');
      return {
        error: { code: 'CLOUD_FORWARD_ERROR', message: (err as Error).message },
      };
    }
  }

  /**
   * Attempt to auto-wake the Fly Machine when the bridge is unreachable.
   * Fly Machines with auto-start will wake on incoming HTTP requests.
   * We just poll the health endpoint until it responds.
   * Deduplicates concurrent wake attempts.
   */
  private async autoWake(): Promise<boolean> {
    if (this.wakeInProgress) {
      return this.wakeInProgress;
    }

    this.wakeInProgress = this.performWake();
    try {
      return await this.wakeInProgress;
    } finally {
      this.wakeInProgress = null;
    }
  }

  private async performWake(): Promise<boolean> {
    if (!this.config) return false;
    const settings = this.config.getSettings();
    const ci = settings.cloudInstance;
    if (!ci?.cloudUrl) return false;

    try {
      // Poll health endpoint — Fly auto-start wakes the machine on the first request
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const resp = await fetch(`${ci.cloudUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
          if (resp.ok) {
            log.info({ attempt }, 'Auto-wake: cloud service is healthy');
            cloudFailureCooldown.reset();
            return true;
          }
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 3_000));
      }

      log.warn('Auto-wake: cloud service did not become healthy within 60s');
      return false;
    } catch (err) {
      log.error({ err }, 'Auto-wake failed');
      return false;
    }
  }

  /**
   * Update the bridge connection when cloud settings change.
   * Creates a new client with the updated URL and token.
   * Drains the outbox after connecting (delivers any pending items).
   */
  async updateConnection(cloudUrl: string, cloudToken: string): Promise<void> {
    if (
      this.httpClient
      && this.connectedCloudUrl === cloudUrl
      && this.connectedCloudToken === cloudToken
    ) {
      this.refreshCloudModeCache();
      return;
    }

    this.disconnect();
    cloudFailureCooldown.reset();
    // MA4: capture the connection generation right after our own disconnect().
    // After EVERY await below, bail before mutating shared connection state if a
    // newer updateConnection() or a direct disconnect() bumped the epoch. This
    // prevents interleaved setup (two rapid calls each run disconnect() — and thus
    // bump the epoch — synchronously before any await resolves, so the loser bails
    // at its first post-await guard; last requested wins) AND post-disconnect
    // resurrection (a direct "cloud disabled" disconnect during setup). Reuses
    // F1's connectionEpoch (disconnect() increments it). See
    // docs/plans/260618_updateconnection-setup-race/PLAN.md.
    const setupEpoch = this.connectionEpoch;
    const { CloudServiceClient } = await loadCloudClient();
    if (this.connectionEpoch !== setupEpoch) {
      log.info({ phase: 'load-client' }, 'updateConnection superseded — aborting stale setup');
      return;
    }
    this.httpClient = new CloudServiceClient(cloudUrl, cloudToken);
    this.connectedCloudUrl = cloudUrl;
    this.connectedCloudToken = cloudToken;
    this.refreshCloudModeCache();
    log.info({ cloudUrl }, 'Cloud connection updated');

    // Connect the persistent event channel for push events (approvals, etc.)
    try {
      const eventChannel = await loadEventChannel();
      // Register interceptors so cloud approval metadata is stored locally.
      // These run on both push (WS events) and pull (IPC responses via hydrateLocalMetadata),
      // ensuring metadata is available regardless of how the data arrives.
      const { registerCloudApprovalMetadata } = await import('../toolSafetyService');
      if (this.connectionEpoch !== setupEpoch) {
        log.info({ phase: 'event-channel-approval' }, 'updateConnection superseded — aborting stale setup');
        return;
      }
      this.toolApprovalInterceptor = registerCloudApprovalMetadata;
      eventChannel.onApprovalReceived(this.toolApprovalInterceptor);

      const { addPendingMemoryApproval } = await import('../safety/pendingApprovalsStore');
      if (this.connectionEpoch !== setupEpoch) {
        log.info({ phase: 'event-channel-memory' }, 'updateConnection superseded — aborting stale setup');
        return;
      }
      this.memoryApprovalInterceptor = async (approval) => {
        const toolUseId = approval.toolUseId as string;
        // Build persisted record from available fields. Catch-up fetches return
        // full PersistedMemoryApprovalRequest; real-time WS events have partial data.
        const dest = approval.destination as Record<string, unknown> | undefined;
        const filePath = ((approval.filePath as string) || (dest?.path as string) || '').trim();
        const spaceName = ((approval.spaceName as string) || (dest?.spaceName as string) || '').trim();
        const destinationSpacePath = typeof dest?.spacePath === 'string'
          ? dest.spacePath.trim()
          : '';
        const topLevelSpacePath = typeof approval.spacePath === 'string'
          ? approval.spacePath.trim()
          : '';
        const settings = this.config?.getSettings();
        const coreDirectory = settings?.coreDirectory;
        let persistedLocation: FileLocation | undefined;
        let persistedSpacePath = destinationSpacePath || topLevelSpacePath || undefined;

        if (coreDirectory && filePath.length > 0) {
          const [{ resolveFileLocation, FileLocationResolverError }, { scanSpaces }] = await Promise.all([
            import('@core/services/fileLocation'),
            import('../spaceService'),
          ]);
          const scannedSpaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
          const resolverSpaces = scannedSpaces.map((space) => ({
            ...space,
            status: space.status ?? 'ok',
          }));

          try {
            const location = await resolveFileLocation(filePath, resolverSpaces, {
              coreDirectory,
            });
            persistedLocation = location;
            const derivedSpacePath = location.kind === 'in-space'
              ? location.workspaceRelativePath
              : location.kind === 'outside-workspace'
                ? location.absolutePath
                : undefined;
            if (derivedSpacePath && derivedSpacePath.trim().length > 0) {
              persistedSpacePath = derivedSpacePath;
            }
            if (location.kind === 'outside-workspace') {
              warnCloudMemoryApprovalLocationFallbackOnce({
                filePath,
                spaceName,
                coreDirectory,
                reason: 'outside-workspace',
              });
            }
          } catch (error) {
            if (error instanceof FileLocationResolverError) {
              // Cross-surface relay carve-out: preserve the approval and let the
              // renderer degrade via legacy fields rather than dropping it.
              warnCloudMemoryApprovalLocationFallbackOnce({
                filePath,
                spaceName,
                coreDirectory,
                reason: 'resolver-error',
              });
            } else {
              throw error;
            }
          }
        }

        addPendingMemoryApproval({
          toolUseId,
          originalTurnId: (approval.originalTurnId as string) || '',
          originalSessionId: (approval.originalSessionId as string) || '',
          turnId: (approval.turnId as string) || '',
          sessionId: (approval.sessionId as string) || '',
          filePath,
          spaceName,
          summary: (approval.summary as string) || '',
          content: (approval.content as string) || '',
          timestamp: (approval.timestamp as number) || Date.now(),
          sensitivityReason: approval.sensitivityReason as string | undefined,
          hasSpaceOverride: approval.hasSpaceOverride as boolean | undefined,
          privateMode: approval.privateMode as boolean | undefined,
          ...(persistedSpacePath ? { spacePath: persistedSpacePath } : {}),
          ...(persistedLocation ? { location: persistedLocation } : {}),
          sharing: (approval.sharing ?? dest?.sharing) as 'private' | 'restricted' | 'company-wide' | 'public' | undefined,
          contentPreview: approval.contentPreview as string | undefined,
          blockedBy: approval.blockedBy as BlockSource | undefined,
          isNewFile: (approval.isNewFile ?? dest?.isNew) as boolean | undefined,
        });
        log.info({ toolUseId }, 'Stored cloud memory approval metadata locally');
      };
      eventChannel.onMemoryApprovalReceived(this.memoryApprovalInterceptor);

      // Register session-change interceptor: sync individual sessions as WS events arrive
      // SAFETY: Cloud sync is additive-only — only upserts, never deletes.
      eventChannel.onSessionChanged(async (event) => {
        try {
          if (event.action === 'upserted') {
            const cloudResult = await this.syncSessionFromCloud(event.sessionId);

            // Layer C self-echo suppression
            // (260427_sidebar_concurrent_swap_groundup_fix.md):
            // The cloud replays our own pushes back over the WS event channel.
            // If the session was recently pushed by THIS process AND
            // syncSessionFromCloud reports no actual local mutation, this is a
            // pure echo of our own write — broadcasting `cloud:sessions-synced`
            // to the renderer would only trigger a wholesale `setSessionSummaries`
            // replace and waste a render. Suppress that broadcast.
            //
            // Important: when `updatedLocal` is true we DO broadcast — that
            // means the cloud carried something new (e.g. a concurrent
            // cross-device update that arrived inside our 5s TTL) that we just
            // merged into the local store, and the renderer needs to know.
            //
            // Multi-window caveat: suppression is global for this Electron
            // process — if multiple BrowserWindows are open, all of them lose
            // this broadcast even though only one initiated the push.
            // Acceptable because multi-window mode is rare; pull-sync (~30s)
            // or focus-driven refresh will reconcile.
            const isPureSelfEcho =
              this.isRecentlyPushedByUs(event.sessionId) && !cloudResult.updatedLocal;
            if (isPureSelfEcho) {
              // TODO: drop back to debug once swap-fix is verified in production
              log.info(
                { sessionId: event.sessionId },
                'Suppressed self-echo cloud:sessions-synced broadcast',
              );
              return;
            }

            const { getBroadcastService: getBroadcast } = await import('@core/broadcastService');
            getBroadcast().sendToAllWindows('cloud:sessions-synced', {
              upserted: [event.sessionId],
              deleted: [],
            });
          } else {
            // Cloud requested a delete — ignored. Local data is authoritative.
            log.info({ sessionId: event.sessionId },
              'Ignoring cloud session delete event — local data is authoritative');
          }
        } catch (err) {
          log.warn({ err, sessionId: event.sessionId, action: event.action },
            'Failed to sync session from cloud event');
        }
      });

      // Register reconnect hook: pull→push sync after WS reconnects.
      // Mirrors the updateConnection() chain so cloud self-heals after any
      // disruption (volume wipe, machine restart, network blip).
      eventChannel.onReconnect(() => {
        // Sessions: pull first (avoids conflicts), then push local state
        this.pullChangedSessions(this.lastSyncTimestamp).then(() => {
          this.pushSessionsToCloud().catch((err) => {
            log.warn({ err }, 'Post-reconnect session push failed');
          });
        }).catch((err) => {
          log.warn({ err }, 'Post-reconnect session sync failed');
        });
        // Inbox: pull first, then push local state
        this.pullInboxChanges().then(() => {
          this.pushInboxToCloud().catch((err) => {
            log.warn({ err }, 'Post-reconnect inbox push failed');
          });
        }).catch((err) => {
          log.warn({ err }, 'Post-reconnect inbox sync failed');
        });
        this.drainOutbox().catch((err) => {
          log.warn({ err }, 'Post-reconnect outbox drain failed');
        });
        // Push continuity + settings (fetch client once, not per-operation)
        fireAndForget(this.getOrCreateClient().then(client => {
          if (!client) return;
          this.pushContinuityStateMap(client, true).catch(err => {
            log.warn({ err }, 'Post-reconnect continuity state map push failed');
          });
          if (this.config) {
            this.forwardSettingsUpdate(client, [this.config.getSettings()]).catch(err => {
              log.warn({ err }, 'Post-reconnect settings push failed');
            });
          }
          // Codex OAuth tokens: re-push current state on reconnect so cloud
          // picks up tokens that were refreshed while disconnected.
          import('@core/services/codexTokenStorage').then(({ loadCodexTokens }) => {
            this.pushCodexTokens(loadCodexTokens(), { source: 'sync' }).catch(err => {
              log.warn({ err }, 'Post-reconnect Codex token push failed');
            });
          }).catch(err => {
            log.warn({ err }, 'Post-reconnect Codex token push: import failed');
          });
          // Managed (Mindstone subscription) OpenRouter key: re-push current
          // state on reconnect so cloud picks up a key provisioned/cleared
          // while disconnected (and replays a pending clear/revoke). The
          // destructive-null guard prevents a transient read-null from wiping
          // a valid cloud key.
          this.pushCurrentManagedKey().catch(err => {
            log.warn({ err }, 'Post-reconnect managed key relay failed');
          });
        }), 'cloud.cloudRouter.line910');
        // MCP config: push on reconnect to catch changes during disconnection
        this.syncMcpConfigToCloud();
      });

      // Register staging bridge: sync cloud-staged .pending.md files to desktop
      // when `memory:staged-files-changed` events arrive from cloud.
      eventChannel.onStagedFilesChanged(() => {
        if (!this.httpClient || !this.config) return;
        const settings = this.config.getSettings();
        const coreDir = settings.coreDirectory;
        if (!coreDir) return;

        import('./cloudStagingBridge').then(({ scheduleStagingSync }) => {
          if (this.httpClient) {
            scheduleStagingSync(this.httpClient, coreDir);
          }
        }).catch((err) => {
          log.warn({ err }, 'Failed to trigger staging bridge sync');
        });
      });

      // Register inbox-changed interceptor: trigger a debounced pull when
      // the cloud service broadcasts inbox mutations via the event channel.
      eventChannel.onInboxChanged(() => {
        this.debouncedInboxPull();
      });

      eventChannel.connect(cloudUrl, cloudToken);
    } catch (err) {
      log.warn({ err }, 'Failed to connect event channel');
    }
    // Re-check after the event-channel try/catch — including the throw path the
    // catch above swallows — so a supersession during event-channel setup bails
    // before installing the follow-on subscriptions/forwarder against a stale
    // connection.
    if (this.connectionEpoch !== setupEpoch) {
      log.info({ phase: 'event-channel-post' }, 'updateConnection superseded — aborting stale setup');
      return;
    }

    // Subscribe to local inbox state changes for debounced push to cloud.
    // Covers ALL local mutations including bypass paths (bundledInboxBridge, plaudSyncService).
    this.subscribeInboxStateChange();

    // Subscribe to MCP config changes for debounced push to cloud.
    // Fires after any writeConfig() in mcpConfigManager (upsert, remove, toggle, etc.).
    this.subscribeMcpConfigChange();

    // Register a second listener for sessions:save-sync (synchronous IPC via ipcMain.on).
    // The primary handler in index.ts saves locally; this forwards to cloud fire-and-forget.
    this.registerSaveSyncForwarder(cloudUrl, cloudToken);

    // Scope outbox to this cloud instance — clears stale entries from a different URL
    const { cloudOutbox } = await import('./cloudOutbox');
    if (this.connectionEpoch !== setupEpoch) {
      log.info({ phase: 'outbox' }, 'updateConnection superseded — aborting stale setup');
      return;
    }
    const countBefore = cloudOutbox.getStatus().pending;
    cloudOutbox.onConnectionChanged(cloudUrl);
    if (countBefore > 0 && cloudOutbox.getStatus().pending === 0) {
      const { getBroadcastService } = await import('@core/broadcastService');
      if (this.connectionEpoch !== setupEpoch) return;
      getBroadcastService().sendToAllWindows('cloud:outbox-changed', cloudOutbox.getStatus());
    }

    // One-time cleanup: demote cloud_active sessions that are not currently
    // pinned (active) on desktop. Historical bulk-sync promoted everything;
    // only sessions the user actively has pinned should remain cloud_active.
    // NOTE: this is intentionally NOT epoch-guarded internally — it is one-time,
    // flag-guarded, connection-INDEPENDENT local hygiene (it demotes by local
    // pinned-state, touches no httpClient/creds, and is idempotent), so it is safe
    // to complete even if a disconnect/switch lands mid-cleanup. The post-call
    // guard below then protects the connection-SPECIFIC pull/push cascade.
    await this.runOneTimeContinuityCleanup();
    if (this.connectionEpoch !== setupEpoch) {
      log.info({ phase: 'continuity-cleanup' }, 'updateConnection superseded — aborting stale setup');
      return;
    }

    // Trigger initial pull so firstPullCompleted gets set (unlocks lifecycle checks).
    // WS onReconnect only fires on RE-connections, not the first connect.
    // Chain lifecycle check after first successful pull to avoid waiting up to an hour.
    // Also trigger initial staging bridge sync to pull any cloud-staged .pending.md files.
    // setupEpoch (captured after disconnect()) gates the follow-on: if a
    // disconnect/account-switch lands while the initial pull is in flight, skip the
    // lifecycle/staging/push/inbox follow-on — it would otherwise run against the
    // wrong connection.
    this.pullChangedSessions().then(() => {
      if (this.connectionEpoch !== setupEpoch) {
        log.info('Skipping post-connect follow-on — connection changed during initial pull');
        return;
      }
      this.runLifecycleCheck().catch((err) => {
        log.warn({ err }, 'Initial lifecycle check failed');
      });
      // Initial staging bridge sync (handles staged files created while desktop was offline)
      this.triggerStagingBridgeSync();
      // Push cloud_active sessions missing/stale on cloud (pull first, then push avoids conflicts)
      this.pushSessionsToCloud().catch((err) => {
        log.warn({ err }, 'Initial session push to cloud failed');
      });
      // Pull inbox first, then push local items to cloud (pull → push ordering avoids conflicts)
      this.pullInboxChanges().then(() => {
        this.pushInboxToCloud().catch((err) => {
          log.warn({ err }, 'Initial inbox push to cloud failed');
        });
      }).catch((err) => {
        log.warn({ err }, 'Initial inbox pull failed');
      });
    }).catch((err) => {
      log.warn({ err }, 'Initial pull on connect failed');
    });

    // Push continuity state map immediately on connect, then start periodic interval.
    // Placed outside pull chain so it runs even if initial pull fails.
    fireAndForget(this.getOrCreateClient().then(client => {
      if (client) this.pushContinuityStateMap(client, true).catch(err => {
        log.warn({ err }, 'Initial continuity state map push failed');
      });
    }), 'cloud.cloudRouter.line1016');
    this.startContinuityPushInterval();

    // Managed (Mindstone subscription) OpenRouter key: re-push current state on
    // INITIAL connect. WS onReconnect only fires on RE-connections, so without
    // this an already-provisioned desktop key (the common case — provisioned
    // before pairing cloud) would stay missing on cloud until an incidental
    // reconnect or the next save/clear mutation. `source: 'sync'` + the
    // destructive-null guard mean a transient read-null never clears, while a
    // durable pending-clear still replays. Idempotent vs reconnect (they don't
    // both run on the same connection).
    this.pushCurrentManagedKey().catch(err => {
      log.warn({ err }, 'Initial managed key relay failed');
    });

    // Push MCP config on connect (belt-and-suspenders: catches changes made while offline).
    this.syncMcpConfigToCloud();

    // Subscribe to workspace watcher events for near-real-time desktop→cloud sync.
    // The watcher may already be running (libraryBroadcaster uses it too).
    this.subscribeWorkspaceWatcher();

    // Drain the outbox now that we have a connection — deliver any pending items.
    this.drainOutbox().catch((err) => {
      log.warn({ err }, 'Post-connect outbox drain failed');
    });

    // Start hourly lifecycle check interval.
    // Clear any existing interval first to prevent duplicates.
    this.clearLifecycleInterval();
    this.lifecycleInterval = setInterval(() => {
      this.runLifecycleCheck().catch((err) => {
        log.warn({ err }, 'Hourly lifecycle check failed');
      });
    }, 60 * 60 * 1_000); // 1 hour

    // Periodic inbox sync — belt-and-suspenders for convergence.
    // Catches edge cases where dual-write failed, cloud events were missed,
    // and user didn't trigger focus. Guarantees convergence within 5 minutes.
    this.clearInboxSyncInterval();
    this.inboxSyncInterval = setInterval(() => {
      this.pullInboxChanges().then(() => {
        this.pushInboxToCloud().catch((err) => {
          log.warn({ err }, 'Periodic inbox push failed');
        });
      }).catch((err) => {
        log.warn({ err }, 'Periodic inbox pull failed');
      });
      // Tombstone cleanup (best-effort)
      import('../inboxStore').then(({ cleanupTombstones }) => {
        const cleaned = cleanupTombstones();
        if (cleaned > 0) log.info({ cleaned }, 'Cleaned up expired inbox tombstones');
      }).catch(() => { /* best-effort */ });
    }, INBOX_SYNC_INTERVAL_MS);
  }

  /**
   * Disconnect from the bridge.
   */
  disconnect(): void {
    // Invalidate any in-flight fire-and-forget pull cascade: bump the connection
    // epoch (so executePullSync/executePullInbox discard stale-account results
    // before writing them locally) and release the pull mutexes (so the NEXT
    // connection's initial pull runs fresh instead of riding the orphaned one).
    // The orphaned wrapper's `finally` is identity-guarded, so clearing the slot
    // here cannot clobber a newer sync's mutex.
    this.connectionEpoch += 1;
    this.activeSyncPromise = null;
    this.activeInboxSyncPromise = null;
    if (this.httpClient) {
      this.httpClient.disconnect();
      this.httpClient = null;
    }
    this.connectedCloudUrl = null;
    this.connectedCloudToken = null;
    if (_eventChannel) {
      _eventChannel.disconnect();
    }
    this.toolApprovalInterceptor = null;
    this.memoryApprovalInterceptor = null;
    this.firstPullCompleted = false;
    this.removeSaveSyncForwarder();
    this.clearLifecycleInterval();
    this.clearContinuityPushInterval();
    this.lastContinuityFingerprint = null;
    this.continuityUnchangedCycles = 0;
    this.clearInboxSyncInterval();
    this.unsubscribeWorkspaceWatcher();
    this.clearStagingBridgeTimers();
    this.unsubscribeInboxStateChange?.();
    this.unsubscribeInboxStateChange = null;
    if (this.inboxPushDebounceTimer) { clearTimeout(this.inboxPushDebounceTimer); this.inboxPushDebounceTimer = null; }
    if (this.inboxPullDebounceTimer) { clearTimeout(this.inboxPullDebounceTimer); this.inboxPullDebounceTimer = null; }
    this.activeInboxPushPromise = null;
    this.unsubscribeMcpConfigChange?.();
    this.unsubscribeMcpConfigChange = null;
    if (this.mcpSyncDebounceTimer) { clearTimeout(this.mcpSyncDebounceTimer); this.mcpSyncDebounceTimer = null; }
    this.mcpConfigDirty = false;
    this.mcpConfigDirtyNewChange = false;
    this.knownSessionTombstones.clear();
    this.lastTombstoneRaceEscalatedAt.clear();
    this.refreshCloudModeCache();
  }

  private parseTombstonesResponse(raw: unknown): ParsedTombstonesResponse {
    const serverNow = (
      raw
      && typeof raw === 'object'
      && typeof (raw as { serverNow?: unknown }).serverNow === 'number'
      && Number.isFinite((raw as { serverNow?: number }).serverNow)
    )
      ? (raw as { serverNow: number }).serverNow
      : undefined;

    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as { tombstones?: unknown[] }).tombstones)
        ? (raw as { tombstones: unknown[] }).tombstones
        : [];

    const tombstones = list
      .filter((item): item is SessionTombstone => (
        !!item
        && typeof item === 'object'
        && typeof (item as { sessionId?: unknown }).sessionId === 'string'
        && typeof (item as { deletedAt?: unknown }).deletedAt === 'number'
        && typeof (item as { ttlExpiresAt?: unknown }).ttlExpiresAt === 'number'
        && (
          (item as { deletedBy?: unknown }).deletedBy === 'desktop'
          || (item as { deletedBy?: unknown }).deletedBy === 'mobile'
          || (item as { deletedBy?: unknown }).deletedBy === 'cloud'
        )
      ))
      .map((item) => ({
        sessionId: item.sessionId,
        deletedAt: item.deletedAt,
        deletedBy: item.deletedBy,
        ttlExpiresAt: item.ttlExpiresAt,
      }));

    return { tombstones, serverNow };
  }

  private warnMissingTombstoneServerNow(): void {
    if (this.warnedMissingTombstoneServerNow) return;
    this.warnedMissingTombstoneServerNow = true;
    log.warn(
      { reason: 'tombstones-no-servernow' },
      'Tombstones endpoint missing serverNow; using client clock',
    );
  }

  private cleanupKnownSessionTombstones(): void {
    const now = Date.now();
    for (const [sessionId, tombstone] of this.knownSessionTombstones) {
      if (tombstone.ttlExpiresAt <= now) {
        this.knownSessionTombstones.delete(sessionId);
      }
    }
  }

  private async refreshSessionTombstones(
    client: CloudServiceClientType,
    epoch?: number,
  ): Promise<SessionTombstone[]> {
    this.cleanupKnownSessionTombstones();
    const { getLastSessionTombstoneSyncAt, setLastSessionTombstoneSyncAt } = await import('./cloudContinuityMetadata');
    const since = getLastSessionTombstoneSyncAt();
    const path = since != null
      ? `/api/sessions/tombstones?since=${encodeURIComponent(String(since))}`
      : '/api/sessions/tombstones';

    try {
      const response = await client.get(path);
      // If the connection changed during the fetch, do NOT repopulate the
      // tombstone cache or advance the persisted cursor with stale-account data
      // (it would suppress upserts and skip valid tombstones for the NEW
      // connection). Callers without an epoch keep the prior behaviour.
      if (epoch !== undefined && this.connectionEpoch !== epoch) {
        return [];
      }
      const { tombstones, serverNow } = this.parseTombstonesResponse(response);
      this.lastSuccessfulTombstoneSyncAt = Date.now();
      const hasServerNow = typeof serverNow === 'number' && Number.isFinite(serverNow);
      if (!hasServerNow) {
        this.warnMissingTombstoneServerNow();
      }

      if (tombstones.length === 0) {
        if (hasServerNow) {
          setLastSessionTombstoneSyncAt(serverNow);
        } else if (since == null) {
          setLastSessionTombstoneSyncAt(Date.now());
        }
        return [];
      }

      let maxDeletedAt = since ?? 0;
      for (const tombstone of tombstones) {
        this.knownSessionTombstones.set(tombstone.sessionId, tombstone);
        maxDeletedAt = Math.max(maxDeletedAt, tombstone.deletedAt);
      }
      if (hasServerNow) {
        maxDeletedAt = Math.max(maxDeletedAt, serverNow);
      }
      setLastSessionTombstoneSyncAt(maxDeletedAt);
      return tombstones;
    } catch (err) {
      // Tombstone endpoint is rate-limited (1/min/device). Keep sync paths resilient.
      const statusCode = isCloudServiceError(err)
        ? (err as { statusCode?: number }).statusCode
        : undefined;
      if (statusCode === 429) {
        this.tombstoneRateLimitedCount++;
        log.debug('Session tombstone sync rate-limited; continuing with cached tombstones');
        return [];
      }
      if (statusCode === 404) {
        this.tombstoneMissingCount++;
        if (!this.warnedTombstoneEndpointMissing) {
          this.warnedTombstoneEndpointMissing = true;
          log.warn(
            { statusCode: 404, path },
            'Session tombstone endpoint returned 404 — continuing with cached tombstones (suppressing further occurrences this session)',
          );
        } else {
          log.debug({ statusCode: 404 }, 'Session tombstone endpoint 404 (repeat)');
        }
        return [];
      }
      throw err;
    }
  }

  getTombstoneStats(): {
    tombstoneMissingCount: number;
    tombstoneRateLimitedCount: number;
    lastSuccessfulSyncAt: number | null;
  } {
    return {
      tombstoneMissingCount: this.tombstoneMissingCount,
      tombstoneRateLimitedCount: this.tombstoneRateLimitedCount,
      lastSuccessfulSyncAt: this.lastSuccessfulTombstoneSyncAt,
    };
  }

  private recordTombstoneContinuityBreadcrumb(args: {
    sessionId: string;
    reason: 'tombstone-applied' | 'tombstone-race-detected';
    direction: string;
    level?: 'info' | 'warning' | 'error';
    tombstoneCount?: number;
    lastTombstoneSyncAt?: number;
  }): void {
    const data: Record<string, unknown> = {
      sessionIdHash: hashSessionIdForBreadcrumb(args.sessionId),
      reason: args.reason,
      direction: args.direction,
    };
    if (typeof args.tombstoneCount === 'number') data.tombstoneCount = args.tombstoneCount;
    if (typeof args.lastTombstoneSyncAt === 'number') data.lastTombstoneSyncAt = args.lastTombstoneSyncAt;

    getErrorReporter().addBreadcrumb({
      category: 'continuity.continuity-state',
      message: args.reason,
      level: args.level ?? 'info',
      data,
    });
    appendDiagnosticEvent(toDiagnosticContinuityTransition({
      family: 'router',
      category: 'continuity.continuity-state',
      message: args.reason,
      level: args.level ?? 'info',
      data,
    }));
  }

  private maybeEscalateTombstoneRace(sessionId: string, direction: string): void {
    const key = direction;
    const now = Date.now();
    const last = this.lastTombstoneRaceEscalatedAt.get(key);
    if (last !== undefined && now - last < TOMBSTONE_RACE_ESCALATION_WINDOW_MS) return;
    this.lastTombstoneRaceEscalatedAt.set(key, now);

    getErrorReporter().captureMessage('Desktop continuity tombstone race detected', {
      level: 'warning',
      tags: {
        continuity_event: 'continuity-state:tombstone-race-detected',
        direction,
        surface: 'desktop',
      },
      extra: {
        sessionIdHash: hashSessionIdForBreadcrumb(sessionId),
      },
    });
  }

  // ---- Session Sync -------------------------------------------------------

  /**
   * Fetch a single session from cloud and upsert it locally.
   * Skips the content upsert when the local version is same or newer (desktop
   * wins ties), but always runs metadata side effects so cloud-sync tracking
   * and activity timestamps stay current.
   *
   * Returns `{ sessionId, updatedLocal }` where `updatedLocal` is true only if
   * the local store was actually mutated (full upsert or successful turn-level
   * merge). The session-changed event handler uses `updatedLocal` together
   * with the recently-pushed marker to suppress pure self-echo broadcasts —
   * see Layer C in 260427_sidebar_concurrent_swap_groundup_fix.md.
   */
  async syncSessionFromCloud(sessionId: string, epoch?: number): Promise<{ sessionId: string; updatedLocal: boolean }> {
    const sessionIdHash = hashSessionId(sessionId);
    const knownTombstone = this.knownSessionTombstones.get(sessionId);
    if (knownTombstone && knownTombstone.ttlExpiresAt > Date.now()) {
      log.info({ sessionIdHash }, 'syncSessionFromCloud skipped: session is tombstoned');
      return { sessionId, updatedLocal: false };
    }

    const { cloudOutbox } = await import('./cloudOutbox');
    if (cloudOutbox.hasPendingDelete(sessionId)) {
      log.info(
        { sessionIdHash },
        'syncSessionFromCloud skipped: pending local outbox delete (resurrection prevention)',
      );
      return { sessionId, updatedLocal: false };
    }

    const client = await this.getOrCreateClient();
    if (!client) {
      log.warn({ sessionIdHash }, 'syncSessionFromCloud: no cloud client available');
      return { sessionId, updatedLocal: false };
    }

    const rawSession = await client.get(`/api/sessions/${encodeURIComponent(sessionId)}`) as AgentSession | null;
    const session = rawSession ? stripConversationAnnotations(rawSession) : null;
    if (!session) {
      log.warn({ sessionIdHash }, 'syncSessionFromCloud: session not found on cloud');
      return { sessionId, updatedLocal: false };
    }

    const { getIncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = getIncrementalSessionStore();

    const localSession = await store.getSession(sessionId);
    // F1: bail before the FIRST durable write in this method — the drift-repair
    // recordLastPushedSeq() below schedules a disk write, so a disconnect during
    // the per-session fetch/getSession awaits above must not let stale-account
    // data advance the outbox push-cursor. (A second guard before the
    // mark/upsert block covers the later continuity-import await.)
    if (epoch !== undefined && this.connectionEpoch !== epoch) {
      return { sessionId, updatedLocal: false };
    }
    const pulledMaxSeq = getMaxSeqFromSession(session);
    const trackedLastPushedSeq = cloudOutbox.getLastPushedSeq(sessionId);
    if (trackedLastPushedSeq !== undefined && pulledMaxSeq < trackedLastPushedSeq) {
      log.warn(
        { sessionIdHash, pulledMaxSeq, trackedLastPushedSeq },
        'session-delta-push:drift-detected',
      );
      cloudOutbox.recordLastPushedSeq(sessionId, pulledMaxSeq);
      getErrorReporter().addBreadcrumb({
        category: 'cloud-sync',
        level: 'warning',
        message: 'session-delta-push:drift-detected',
        data: { sessionIdHash: hashSessionIdForBreadcrumb(sessionId), pulledMaxSeq, trackedLastPushedSeq },
      });
    }

    const pulledIdentities = getSessionEventIdentities(session);
    const restampResult = localSession
      ? restampLocalOnlyEventsAboveSeq(localSession, pulledIdentities, pulledMaxSeq)
      : null;
    const localSessionForMerge = restampResult?.session ?? localSession;
    const restampedLocalOnlyCount = restampResult?.restampedCount ?? 0;

    // Guard: only overwrite local data when the cloud version is strictly newer.
    // This protects desktop-executed turns from being clobbered by a stale cloud pull.
    const skipUpsert = localSessionForMerge && localSessionForMerge.updatedAt >= session.updatedAt;

    // SAFETY: Route through the additive mergeSessionTurns path whenever local
    // has content the cloud snapshot lacks — either a turn cloud doesn't know
    // about, or (new: REBEL-6C0 fix) more non-user messages / more events on a
    // shared turn. This prevents a chronologically-newer-but-semantically-older
    // cloud snapshot (e.g. updatedAt bumped by a memory/activity push) from
    // full-replacing the local final answer on a shared turn.
    //
    // `localHasUnknownTurns` (turn-ID-set-only) is kept for the log message;
    // the routing now uses the broadened `localHasContentCloudLacks` predicate
    // which subsumes it. `skipUpsert=true` is always content-safe (it keeps
    // local), so the timestamp-only guard there is not a second hole.
    //
    // See docs/plans/260622_fix-message-render-drop/PLAN.md Stage 1.
    const localHasUnknownTurns = localSessionForMerge && hasLocalOnlyTurns(localSessionForMerge, session);
    const localContentExceedsCloud = localSessionForMerge && localHasContentCloudLacks(localSessionForMerge, session);

    // Only promote to cloud_active if the session is not explicitly local_only.
    // This prevents re-promoting sessions the user demoted via unpin.
    const {
      getContinuityEntry,
      markCloudActive,
      touchCloudActivity,
      restoreContinuityEntrySnapshot,
      flushContinuityMetadata,
    } = await import('./cloudContinuityMetadata');
    const existingEntry = getContinuityEntry(sessionId);
    const existingEntrySnapshot = existingEntry
      ? {
        ...existingEntry,
        ...(existingEntry.cloudRemovalIntent
          ? { cloudRemovalIntent: { ...existingEntry.cloudRemovalIntent } }
          : {}),
      }
      : null;
    const shouldPromoteCloudActive = existingEntry?.state !== 'local_only';
    const didTransitionToCloudActive = shouldPromoteCloudActive && existingEntry?.state !== 'cloud_active';

    // F1: if the connection changed during this per-session cloud fetch (the
    // dominant network await above), abort before writing any stale-account
    // state. Placed before the cloud_active-mark + upsert transactional block
    // (not inside it) to avoid a half-commit; callers without an epoch keep
    // prior behaviour (WS-driven single-session sync).
    if (epoch !== undefined && this.connectionEpoch !== epoch) {
      return { sessionId, updatedLocal: false };
    }

    if (shouldPromoteCloudActive) {
      markCloudActive(sessionId);
      touchCloudActivity(sessionId);

      // Synchronous flush is only needed for the actual transition case
      // (no entry/local_only -> cloud_active) to close the race window where a
      // concurrent state-map push could read stale persisted metadata.
      if (didTransitionToCloudActive) {
        const flushResult = await flushContinuityMetadata();
        if (!flushResult.success) {
          log.warn(
            {
              phase: 'cloud-sync-mark',
              sessionIdHash: hashSessionIdForBreadcrumb(sessionId),
              errorMessage: getErrorMessage(flushResult.error),
            },
            'Failed to flush continuity metadata after cloud mark',
          );
        }
      }
    }

    let upsertedSession: AgentSession | null = null;
    let attemptedLocalWrite = false;

    try {
      if (skipUpsert) {
        log.info(
          { sessionIdHash, localUpdatedAt: localSessionForMerge.updatedAt, cloudUpdatedAt: session.updatedAt },
          'Skipping cloud session upsert: local version is same or newer',
        );
        if (restampedLocalOnlyCount > 0 && localSessionForMerge) {
          attemptedLocalWrite = true;
          upsertedSession = await this.upsertSessionIfWritten(store, localSessionForMerge);
        }
      } else if ((localContentExceedsCloud || restampedLocalOnlyCount > 0) && localSessionForMerge) {
        // Content-preserving merge: local has content the cloud snapshot lacks —
        // either a turn cloud doesn't know about (localHasUnknownTurns), or local
        // has more non-user messages / events on a shared turn
        // (localHasContentCloudLacks). Route through the additive mergeSessionTurns
        // path to keep the local final answer while still incorporating any
        // cloud-only additions (e.g. new turns from mobile/web).
        const merged = mergeSessionTurns(
          localSessionForMerge,
          session,
          (turnId) => agentTurnRegistry.getActiveTurnController(turnId) !== undefined,
        );
        if (merged) {
          attemptedLocalWrite = true;
          upsertedSession = await this.upsertSessionIfWritten(store, merged);
          if (upsertedSession) {
            log.info(
              {
                sessionId,
                localMessages: localSessionForMerge.messages?.length,
                cloudMessages: session.messages?.length,
                mergedMessages: merged.messages?.length,
                // Report each routing reason independently (they can co-occur):
                // local-only turns AND same-turn content divergence are not
                // mutually exclusive. `localContentExceedsCloud` is true whenever
                // EITHER fires; `hadUnknownTurns` distinguishes the turn-ID-set
                // difference; `hadContentDivergence` is the residual same-turn
                // signal (more non-user messages / higher per-turn max seq).
                hadUnknownTurns: localHasUnknownTurns,
                hadContentDivergence: localContentExceedsCloud,
                routedByRestamp: restampedLocalOnlyCount > 0,
              },
              'Content-preserving merge: kept local content while incorporating cloud additions',
            );
          }
        } else if (restampedLocalOnlyCount > 0) {
          attemptedLocalWrite = true;
          upsertedSession = await this.upsertSessionIfWritten(store, localSessionForMerge);
          if (upsertedSession) {
            log.info(
              { sessionIdHash, restampedLocalOnlyCount, pulledMaxSeq },
              'Pull cursor gate restamped local-only events without additional cloud content',
            );
          }
        } else {
          log.info(
            { sessionId },
            'Turn-level merge: no new content from cloud, skipping upsert',
          );
        }
      } else {
        // No local-only turns — safe to accept cloud version (with metadata protection)
        if (localSession) {
          // Preserve local lifecycle fields over the accepted cloud version.
          session.doneAt = localSession.doneAt;
          session.starredAt = localSession.starredAt;
          session.deletedAt = localSession.deletedAt;
          // Accept cloud title over a local auto-overwritable title (default OR
          // the broader fallback set: 'New Agent Run', 'Conversation N',
          // first-message fallback, blank). A local manual rename (a real,
          // non-fallback title) is preserved; an auto-overwritable title yields to
          // the cloud's auto-generated title. The auto-title metadata always
          // travels with the winning title. `resolvePulledTitle` is the single
          // shared title-merge primitive — the SAME `isDefaultOrFallbackTitle`
          // predicate backs the turn-level `mergeSessionTurns` and the desktop-push
          // `mergeDesktopPushIntoCloud`, so the policy can't drift across the three
          // merge sites.
          const resolvedTitle = resolvePulledTitle(localSession, session);
          session.title = resolvedTitle.title;
          session.autoTitleGeneratedAt = resolvedTitle.autoTitleGeneratedAt;
          session.autoTitleTurnCount = resolvedTitle.autoTitleTurnCount;
          session.annotations = localSession.annotations;
        }
        // Self-heal: recompute updatedAt from content to fix sessions poisoned
        // by a previous server-side bug that overwrote updatedAt with Date.now().
        session.updatedAt = deriveSessionUpdatedAt(session);
        attemptedLocalWrite = true;
        upsertedSession = await this.upsertSessionIfWritten(store, session);
      }
    } catch (err) {
      if (shouldPromoteCloudActive) {
        // Prevent a half-commit: if we marked cloud_active before upsert and the
        // upsert fails, restore metadata to the pre-mark snapshot.
        restoreContinuityEntrySnapshot(sessionId, existingEntrySnapshot);
        const rollbackFlushResult = await flushContinuityMetadata();
        if (!rollbackFlushResult.success) {
          log.warn(
            {
              phase: 'cloud-sync-rollback',
              sessionIdHash: hashSessionIdForBreadcrumb(sessionId),
              errorMessage: getErrorMessage(rollbackFlushResult.error),
            },
            'Failed to flush continuity metadata rollback after cloud sync failure',
          );
        }
      }
      throw err;
    }

    if (attemptedLocalWrite && !upsertedSession) {
      if (shouldPromoteCloudActive) {
        restoreContinuityEntrySnapshot(sessionId, existingEntrySnapshot);
        const rollbackFlushResult = await flushContinuityMetadata();
        if (!rollbackFlushResult.success) {
          log.warn(
            {
              phase: 'cloud-sync-refused-rollback',
              sessionIdHash: hashSessionIdForBreadcrumb(sessionId),
              errorMessage: getErrorMessage(rollbackFlushResult.error),
            },
            'Failed to flush continuity metadata rollback after refused cloud sync write',
          );
        }
      }
      log.info({ sessionIdHash }, 'Cloud session sync skipped: local session write was refused');
      return { sessionId, updatedLocal: false };
    }

    // Always propagate the cloud's cloudUpdatedAt to the outbox tracker,
    // regardless of which merge path ran (skipUpsert, localHasUnknownTurns,
    // or full upsert). During active turns, the local session's updatedAt
    // races ahead of cloud's so skip/merge paths fire frequently. Without
    // propagating, the outbox sends stale cloudUpdatedAt on the next push,
    // triggering false stale-metadata conflicts ("Edited elsewhere").
    if (typeof session.cloudUpdatedAt === 'number' && Number.isFinite(session.cloudUpdatedAt)) {
      cloudOutbox.recordCloudUpdatedAt(sessionId, session.cloudUpdatedAt);
    }

    const currentCursor = cloudOutbox.getLastPushedSeq(sessionId);
    if (currentCursor === undefined || pulledMaxSeq > currentCursor) {
      cloudOutbox.recordLastPushedSeq(sessionId, Math.max(currentCursor ?? 0, pulledMaxSeq));
    }

    // Only run post-write metadata/index side effects when persistence accepted
    // a session write. Delete-wins refusals must not mark stale state as synced.
    if (upsertedSession) {
      const { markCloudSynced } = await import('./cloudSyncMetadata');
      markCloudSynced(sessionId);
      const { onSessionsSaved } = await import('../conversationIndexService');
      onSessionsSaved([upsertedSession]).catch(() => {});
    }

    const externalContextForBinding = (
      upsertedSession
      ?? localSessionForMerge
      ?? localSession
      ?? session
    ).externalContext;
    if (externalContextForBinding?.kind === 'slack-thread') {
      conversationScopeResolver.bindConversation(sessionId, externalContextForBinding);
    }

    log.info({ sessionIdHash }, 'Synced session from cloud');
    return { sessionId, updatedLocal: upsertedSession !== null };
  }

  /**
   * Restore conversation folders from the cloud carrier (`/api/sessions/folders`)
   * during the first-connect pull. Fixes the data-loss class where folder
   * structure was uploaded/pulled nowhere (see PLAN.md Root Cause).
   *
   * - GET the folders doc (mirrors `/api/settings` GET, Amendment A4).
   * - A2: any response that doesn't parse to a valid current-version doc
   *   (404 / malformed / future-version) ⇒ NO-OP, never clobber local.
   * - A trivial cloud doc (no folders + no membership) is treated as nothing
   *   to restore — don't blow away local folders the user just created.
   * - Merge + prune via `reconcileRestoredFolders` (F1/F6/F7).
   * - F9: persist via `getFolderStore().save()` (primes cache + disk) so a
   *   later `load()` empty-default can't race ahead of the restore.
   * - A1 (CRITICAL): broadcast `cloud:folders-restored` so the renderer
   *   Zustand store re-loads — priming main-process disk alone leaves the
   *   sidebar empty until restart (the original user-visible symptom).
   */
  private async restoreFoldersFromCloud(
    client: CloudServiceClientType,
    presentSessionIds: ReadonlySet<string>,
    epoch?: number,
  ): Promise<void> {
    const { parseFolderStoreData } = await import('@shared/ipc/schemas/folders');

    let raw: unknown;
    try {
      raw = await client.get('/api/sessions/folders');
    } catch (err) {
      // 404 (older cloud-service without the route) or transport error ⇒ no-op.
      // Restore is best-effort: a missing/unreachable carrier must never abort
      // the pull sync or clobber local folders (A2/F5).
      ignoreBestEffortCleanup(err, {
        operation: 'restore_folders_from_cloud_get',
        reason: 'folders carrier 404/unreachable ⇒ treat as no cloud folders, keep local',
      });
      log.info({ err }, 'Folders restore: GET failed/absent — treating as no cloud folders');
      return;
    }

    const cloud = parseFolderStoreData(raw);
    if (!cloud) {
      // Malformed / unknown-version / null ⇒ no-op, never clobber local (A2).
      log.info('Folders restore: cloud doc did not parse to a valid v1 document — no-op');
      return;
    }

    const cloudIsTrivial =
      cloud.folders.length === 0 && Object.keys(cloud.membership).length === 0;
    if (cloudIsTrivial) {
      log.info('Folders restore: cloud folders are empty — nothing to restore, preserving local');
      return;
    }

    const { getFolderStore } = await import('@core/services/folderStore');
    const folderStore = getFolderStore();
    const local = folderStore.load();

    const reconciled = reconcileRestoredFolders({
      cloud,
      local,
      presentSessionIds,
    });

    // Connection changed during the folder fetch/import/load — don't write
    // stale-account folder membership locally. Callers without an epoch keep
    // the prior behaviour.
    if (epoch !== undefined && this.connectionEpoch !== epoch) {
      return;
    }

    // F9 amplifier fix: save() primes both the in-memory cache and disk, so a
    // subsequent FolderStore.load() returns the restored doc rather than
    // resetting to empty defaults.
    await folderStore.save(reconciled);

    // A1: re-trigger the renderer Zustand store's loadFolders so the sidebar
    // reflects the restore without a restart. Mirrors `cloud:sessions-synced`.
    const { getBroadcastService } = await import('@core/broadcastService');
    getBroadcastService().sendToAllWindows('cloud:folders-restored', {
      folderCount: reconciled.folders.length,
      membershipCount: Object.keys(reconciled.membership).length,
    });

    log.info(
      {
        folderCount: reconciled.folders.length,
        membershipCount: Object.keys(reconciled.membership).length,
      },
      'Folders restored from cloud and renderer notified',
    );
  }

  // REMOVED: syncDeletedSession — cloud must NEVER delete local sessions.
  // Local data is authoritative. Cloud is additive-only (continuity mirror).

  /**
   * Pull all changed sessions from cloud and upsert locally (additive-only).
   * Compares cloud summaries against local summaries to detect new/updated sessions.
   * Never deletes local sessions — cloud is a continuity mirror, not a source of truth.
   * Protected by a mutex to prevent overlapping syncs.
   */
  async pullChangedSessions(_since?: number): Promise<void> {
    if (!cloudFailureCooldown.isAvailable()) {
      log.debug('pullChangedSessions: skipped (failure cooldown active)');
      return;
    }
    // If a sync is already in progress, wait for it instead of silently skipping.
    // This ensures cloud:destroy's "final sync" isn't lost when focus-triggered sync is running.
    if (this.activeSyncPromise) {
      log.info('pullChangedSessions: awaiting in-progress sync');
      await this.activeSyncPromise;
      return;
    }

    const syncPromise = this.executePullSync();
    this.activeSyncPromise = syncPromise;
    try {
      const outcome = await syncPromise;
      if (outcome.superseded) {
        // Connection changed mid-pull — results were discarded. Do NOT mark
        // firstPullCompleted or record a cooldown verdict for an abandoned sync.
        log.info('pullChangedSessions: sync superseded by disconnect/reconnect');
        return;
      }
      this.firstPullCompleted = true;
      cloudFailureCooldown.recordCooldownVerdict(outcome);
    } catch (err) {
      recordCloudFailure(err);
      this.checkAutoRecovery();
      throw err;
    } finally {
      // Identity-guard: only release the mutex if it still points at OUR sync.
      // disconnect() nulls it on connection teardown, and a newer pull may have
      // claimed the slot — clobbering that would re-open the overlap window.
      if (this.activeSyncPromise === syncPromise) {
        this.activeSyncPromise = null;
      }
    }
  }

  private async executePullSync(): Promise<CloudSyncOutcome> {
    const syncStart = Date.now();
    // Capture the connection generation at entry; bail before any store mutation
    // if disconnect()/updateConnection() supersedes us (stops stale-account writes).
    const epoch = this.connectionEpoch;
    try {
      const client = await this.getOrCreateClient();
      if (!client) {
        log.warn('pullChangedSessions: no cloud client available');
        return cloudSuccessOutcome();
      }

      // Fetch cloud summaries (full list needed for delete detection).
      // The cloud API returns { sessions: [...], totalCount } since d1f2ffabd.
      const raw = await client.get('/api/sessions?summaries=true') as
        | Array<{ id: string; updatedAt: number }>
        | { sessions: Array<{ id: string; updatedAt: number }>; totalCount?: number };
      const cloudSummaries = Array.isArray(raw) ? raw : raw?.sessions;
      if (!Array.isArray(cloudSummaries)) {
        log.warn('pullChangedSessions: cloud returned non-array for summaries');
        return cloudFailureOutcome('cloud returned non-array for summaries');
      }
      const outcome = cloudSuccessOutcome();

      // Fetch local summaries
      const { getIncrementalSessionStore } = await import('../incrementalSessionStore');
      const store = getIncrementalSessionStore();
      // Stage 2: reconciliation compares full local state, including internal sessions.
      const localSummaries = store.listSessions({ includeInternal: true });

      // Build lookup map for upsert detection
      const localById = new Map(localSummaries.map((s) => [s.id, s]));
      const { cloudOutbox } = await import('./cloudOutbox');
      const pendingLocalDeletes = cloudOutbox.getPendingDeleteSessionIds();

      // Upsert detection: cloud session with updatedAt > local updatedAt, or not present locally
      const toUpsert: string[] = [];
      let suppressedPendingDeletes = 0;
      for (const cs of cloudSummaries) {
        if (this.knownSessionTombstones.has(cs.id)) {
          continue;
        }
        if (pendingLocalDeletes.has(cs.id)) {
          suppressedPendingDeletes += 1;
          continue;
        }
        const local = localById.get(cs.id);
        if (!local || cs.updatedAt > local.updatedAt) {
          toUpsert.push(cs.id);
        }
      }
      if (suppressedPendingDeletes > 0) {
        log.info(
          { pendingDeletesTotal: pendingLocalDeletes.size, suppressedPendingDeletes },
          'pullChangedSessions: suppressed cloud upserts with pending local delete outbox entries',
        );
        if (suppressedPendingDeletes >= 10) {
          getErrorReporter().addBreadcrumb({
            category: 'cloud-pull-mass-suppression',
            message: `Suppressed ${suppressedPendingDeletes} cloud upserts due to pending local outbox deletes`,
            data: {
              pendingDeletesTotal: pendingLocalDeletes.size,
              suppressedPendingDeletes,
            },
          });
        }
      }

      // SAFETY: Cloud sync is additive-only. Cloud NEVER deletes local sessions.
      // Local data is authoritative — cloud is a continuity mirror, not a source of truth.

      // Execute upserts.
      // Bail if the connection changed during the network fetch above, and
      // re-check each iteration so a mid-loop disconnect stops after at most one
      // more session (syncSessionFromCloud re-derives the client + writes store
      // state; additive sync self-heals the at-most-one straggler).
      if (this.connectionEpoch !== epoch) {
        log.info('pullChangedSessions: connection changed before upserts — discarding stale results');
        return cloudSupersededOutcome();
      }
      const upserted: string[] = [];
      for (const id of toUpsert) {
        if (this.connectionEpoch !== epoch) {
          return cloudSupersededOutcome();
        }
        try {
          await this.syncSessionFromCloud(id, epoch);
          upserted.push(id);
          outcome.ok += 1;
        } catch (err) {
          addOutcomeFailure(outcome, err);
          log.warn({ err, sessionIdHash: hashSessionId(id) }, 'Failed to sync session from cloud');
        }
      }

      // Stale cross-account tombstones must NEVER delete local sessions, and
      // refreshSessionTombstones() itself mutates persisted tombstone state —
      // guard before it, and again each iteration before a destructive delete.
      if (this.connectionEpoch !== epoch) {
        return cloudSupersededOutcome();
      }
      const deletedByTombstone: string[] = [];
      try {
        const tombstones = await this.refreshSessionTombstones(client, epoch);
        if (tombstones.length > 0) {
          const { removeContinuityMetadata, getLastSessionTombstoneSyncAt } = await import('./cloudContinuityMetadata');
          const { removeCloudSyncMetadata } = await import('./cloudSyncMetadata');
          const { clearSessionApprovals } = await import('../toolSafetyService');
          const lastCursor = getLastSessionTombstoneSyncAt() ?? null;
          for (const tombstone of tombstones) {
            if (this.connectionEpoch !== epoch) break;
            const localSession = await store.getSession(tombstone.sessionId);
            // Re-check AFTER the getSession await, before the destructive delete:
            // a disconnect during that await must not let a stale-account
            // tombstone delete a local session.
            if (this.connectionEpoch !== epoch) break;
            if (localSession) {
              // Intent: 'user-delete' (Stage 3 classification table) — applying
              // a cross-device tombstone IS the delete-wins point: the remote
              // user's deletion must hold locally against stale writes.
              await store.deleteSession(tombstone.sessionId, { intent: 'user-delete' });
              clearSessionApprovals(tombstone.sessionId);
              deletedByTombstone.push(tombstone.sessionId);
              outcome.ok += 1;
              this.recordTombstoneContinuityBreadcrumb({
                sessionId: tombstone.sessionId,
                reason: 'tombstone-applied',
                direction: 'desktop-pull',
                tombstoneCount: tombstones.length,
                lastTombstoneSyncAt: lastCursor ?? undefined,
              });
            }
            removeContinuityMetadata(tombstone.sessionId);
            removeCloudSyncMetadata(tombstone.sessionId);
          }
        }
      } catch (err) {
        addOutcomeFailure(outcome, err);
        log.warn({ err }, 'Failed to apply session tombstones during pull sync');
      }

      // Restore conversation folders from the cloud carrier. MUST run AFTER
      // the session-upsert loop + tombstone application so the membership
      // prune (F1/F7) sees sessions that arrived in this same pull and drops
      // rows for sessions that were tombstoned. A folders failure must never
      // abort the (already-complete) session pull — wrap in try/catch.
      //
      // Present-session set = sessions already local UNION the ones just
      // upserted in this pull, MINUS the ones tombstoned/deleted. Mock stores
      // in tests don't reflect upserts via getSessionIds(), so we union
      // explicitly rather than re-reading the store.
      // Folder restore writes folderStore — skip if the connection changed.
      // (lastSyncTimestamp + the renderer broadcast below are intentionally left
      // unguarded: both merely reflect the local state actually applied above.)
      if (this.connectionEpoch !== epoch) {
        return cloudSupersededOutcome();
      }
      const presentSessionIds = new Set<string>(store.getSessionIds());
      for (const id of upserted) presentSessionIds.add(id);
      for (const id of deletedByTombstone) presentSessionIds.delete(id);
      await this.restoreFoldersFromCloud(client, presentSessionIds, epoch).catch((err) => {
        log.warn({ err }, 'Folders restore failed during pull sync (non-fatal)');
      });

      this.lastSyncTimestamp = Date.now();

      const deletedSet = new Set(deletedByTombstone);
      const visibleUpserted = upserted.filter((id) => !deletedSet.has(id));

      // Notify renderer
      const { getBroadcastService } = await import('@core/broadcastService');
      getBroadcastService().sendToAllWindows('cloud:sessions-synced', {
        upserted: visibleUpserted,
        deleted: deletedByTombstone,
      });

      log.info({
        direction: 'pull',
        entity: 'sessions',
        upserted: visibleUpserted.length,
        deleted: deletedByTombstone.length,
        cloudOnly: toUpsert.length,
        duration: Date.now() - syncStart,
      }, 'Pull sync complete');
      return outcome;
    } catch (err) {
      log.warn({ err }, 'Pull sync failed');
      throw err;
    }
  }

  /**
   * Pull settings from cloud — permanently disabled.
   *
   * Desktop is the sole authority for all settings. Cloud/mobile/web inherit
   * settings from desktop via push (outbox), never the other way around.
   * This is intentional and permanent — not a TODO.
   *
   * @see docs/plans/partway/260224_cloud_sync_safety_hardening.md
   */
  async pullSettings(): Promise<void> {
    // Intentional no-op.
  }

  /**
   * Pull inbox changes from cloud and merge into local store.
   * Adds items that exist on cloud but not locally, and reconciles archive
   * state for existing items (cloud wins when its archivedAt is strictly newer).
   * Desktop is authoritative — content fields are never modified by cloud.
   */
  async pullInboxChanges(): Promise<void> {
    if (!cloudFailureCooldown.isAvailable()) {
      log.debug('pullInboxChanges: skipped (failure cooldown active)');
      return;
    }
    if (this.activeInboxSyncPromise) {
      log.info('pullInboxChanges: awaiting in-progress sync');
      await this.activeInboxSyncPromise;
      return;
    }

    const inboxPromise = this.executePullInbox();
    this.activeInboxSyncPromise = inboxPromise;
    try {
      const outcome = await inboxPromise;
      if (outcome.superseded) {
        // Connection changed mid-pull — local inbox writes were discarded.
        log.info('pullInboxChanges: sync superseded by disconnect/reconnect');
        return;
      }
      cloudFailureCooldown.recordCooldownVerdict(outcome);
    } catch (err) {
      recordCloudFailure(err);
      this.checkAutoRecovery();
    } finally {
      // Identity-guard (see pullChangedSessions): don't clobber a newer sync.
      if (this.activeInboxSyncPromise === inboxPromise) {
        this.activeInboxSyncPromise = null;
      }
    }
  }

  private async executePullInbox(): Promise<CloudSyncOutcome> {
    // Capture connection generation; bail before applying inbox mutations if
    // disconnect()/updateConnection() supersedes us (stops stale-account writes).
    const epoch = this.connectionEpoch;
    try {
      const client = await this.getOrCreateClient();
      if (!client) {
        log.warn('pullInboxChanges: no cloud client available');
        return cloudSuccessOutcome();
      }

      // Fetch cloud inbox index (full shape with updatedAt, addedAt, deletedIds)
      const cloudIndex = await client.post(
        `/api/ipc/${encodeURIComponent('inbox:load-index')}`,
        { params: [] }
      ) as {
        entries?: Array<{ id: string; archived?: boolean; archivedAt?: number; updatedAt?: number; addedAt: number; status?: string }>;
        deletedIds?: Array<{ id: string; deletedAt: number }>;
        history?: Array<{ id: string }>;
        migrationComplete?: boolean;
      } | null;

      if (!cloudIndex?.entries || !Array.isArray(cloudIndex.entries)) {
        log.warn('pullInboxChanges: cloud returned invalid index');
        return cloudFailureOutcome('cloud returned invalid inbox index');
      }
      const outcome = cloudSuccessOutcome();

      // Load local inbox index and tombstones
      const { getInboxIndexSnapshot, getDeletedIds, computeInboxSyncPlan } = await import('../inboxStore');
      const localIndex = getInboxIndexSnapshot();
      const localTombstones = getDeletedIds();
      const localHistoryIds = new Set(localIndex.history.map(h => h.id));
      const cloudTombstones = Array.isArray(cloudIndex.deletedIds) ? cloudIndex.deletedIds : [];

      // Compute sync plan
      const plan = computeInboxSyncPlan(
        localIndex.entries,
        cloudIndex.entries,
        localTombstones,
        cloudTombstones,
        localHistoryIds,
      );

      // Reconcile cloud history: items executed on cloud (in history) that
      // desktop still has as active should be marked completed locally.
      // Only if the item is NOT also active in cloud entries (which would
      // mean the item was re-opened/re-added on cloud after execution).
      // Connection changed during the index fetch — discard before mutating
      // local inbox state (history-complete / upsert / delete below).
      if (this.connectionEpoch !== epoch) {
        return cloudSupersededOutcome();
      }
      let completedLocallyFromHistory = 0;
      const cloudHistoryIds = new Set(
        Array.isArray(cloudIndex?.history) ? cloudIndex.history.map(h => h.id) : []
      );
      const cloudActiveIds = new Set(
        cloudIndex.entries
          .filter(e => !e.archived && (!e.status || e.status === 'active' || e.status === 'executing'))
          .map(e => e.id)
      );
      if (cloudHistoryIds.size > 0) {
        const { setInboxItemStatus } = await import('../inboxStore');
        if (this.connectionEpoch !== epoch) {
          return cloudSupersededOutcome();
        }
        const localActiveEntries = localIndex.entries.filter(
          e => !e.archived && (!e.status || e.status === 'active' || e.status === 'executing')
        );
        for (const entry of localActiveEntries) {
          if (entry.status === 'executing') continue; // Never clobber in-progress work
          if (cloudHistoryIds.has(entry.id) && !cloudActiveIds.has(entry.id)) {
            try {
              setInboxItemStatus(entry.id, 'completed');
              completedLocallyFromHistory++;
              outcome.ok += 1;
            } catch (err) {
              addOutcomeFailure(outcome, err);
              log.debug({ id: entry.id, err: (err as Error).message }, 'Failed to complete item from cloud history');
            }
          }
        }
      }

      const hasChanges = plan.toFetchFromCloud.length > 0 || plan.toDeleteLocally.length > 0 || completedLocallyFromHistory > 0;
      if (!hasChanges) {
        log.info({ direction: 'pull', entity: 'inbox' }, 'Inbox pull: no changes needed');
        return outcome;
      }

      // Fetch full items from cloud for toFetchFromCloud
      let upsertedCount = 0;
      if (plan.toFetchFromCloud.length > 0) {
        const cloudItems = await client.post(
          `/api/ipc/${encodeURIComponent('inbox:load-items')}`,
          { params: [{ ids: plan.toFetchFromCloud }] }
        ) as Array<Record<string, unknown>> | null;

        if (Array.isArray(cloudItems) && cloudItems.length > 0) {
          const { InboxItemSchema } = await import('@shared/ipc/schemas/inbox');
          const { upsertInboxItemFromCloud } = await import('../inboxStore');
          if (this.connectionEpoch !== epoch) {
            return cloudSupersededOutcome();
          }
          for (const cloudItem of cloudItems) {
            const parsed = InboxItemSchema.safeParse(cloudItem);
            if (!parsed.success) {
              addOutcomeFailure(outcome, parsed.error);
              log.warn({ id: (cloudItem as Record<string, unknown>).id, errors: parsed.error.issues.length }, 'Skipping malformed cloud inbox item');
              continue;
            }
            if (upsertInboxItemFromCloud(parsed.data as InboxItem)) {
              upsertedCount++;
            }
            outcome.ok += 1;
          }
        } else {
          addOutcomeFailure(outcome, 'cloud returned no items for requested inbox IDs');
          log.warn({ toFetch: plan.toFetchFromCloud.length }, 'pullInboxChanges: cloud returned no items for requested IDs');
        }
      }

      // Delete items locally that cloud deleted
      let deletedLocallyCount = 0;
      if (plan.toDeleteLocally.length > 0) {
        const { removeInboxItem } = await import('../inboxStore');
        // Stale cross-account deletes must NEVER remove local inbox items.
        if (this.connectionEpoch !== epoch) {
          return cloudSupersededOutcome();
        }
        for (const id of plan.toDeleteLocally) {
          try {
            removeInboxItem(id);
            deletedLocallyCount++;
            outcome.ok += 1;
          } catch (err) {
            addOutcomeFailure(outcome, err);
            log.debug({ id, err: (err as Error).message }, 'Failed to delete local inbox item from cloud tombstone');
          }
        }
      }

      // Broadcast updated state if any changes were made
      if (upsertedCount > 0 || deletedLocallyCount > 0 || completedLocallyFromHistory > 0) {
        const { getInboxState } = await import('../inboxStore');
        const { getBroadcastService } = await import('@core/broadcastService');
        getBroadcastService().sendToAllWindows('inbox:state', getInboxState());
        log.info(
          { direction: 'pull', entity: 'inbox', upserted: upsertedCount, deletedLocally: deletedLocallyCount, completedFromCloudHistory: completedLocallyFromHistory, fetchRequested: plan.toFetchFromCloud.length },
          'Inbox pull complete',
        );
      } else {
        log.info({ direction: 'pull', entity: 'inbox' }, 'Inbox pull: all items already up to date locally');
      }
      return outcome;
    } catch (err) {
      log.warn({ err }, 'Inbox pull failed');
      throw err;
    }
  }

  /**
   * Push cloud_active sessions to cloud that are missing or stale.
   * Runs on connect after pull sync to ensure desktop→cloud consistency.
   * Desktop is authoritative — cloud gets overwritten with local state.
   * Fire-and-forget — errors are logged, not thrown.
   */
  async pushSessionsToCloud(): Promise<void> {
    if (!cloudFailureCooldown.isAvailable()) {
      log.debug('pushSessionsToCloud: skipped (failure cooldown active)');
      return;
    }
    try {
      const client = await this.getOrCreateClient();
      if (!client) {
        log.warn('pushSessionsToCloud: no cloud client available');
        return;
      }

      const { getAllContinuityStates } = await import('./cloudContinuityMetadata');
      const { markCloudSynced } = await import('./cloudSyncMetadata');
      const allStates = getAllContinuityStates();

      // Collect cloud_active session IDs
      const cloudActiveIds: string[] = [];
      for (const [sid, entry] of Object.entries(allStates)) {
        if (entry && typeof entry === 'object' && (entry as { state?: string }).state === 'cloud_active') {
          cloudActiveIds.push(sid);
        }
      }
      if (cloudActiveIds.length === 0) return;

      // Fetch cloud summaries to detect missing/stale sessions.
      // The cloud API returns { sessions: [...], totalCount } since d1f2ffabd.
      const pushRaw = await client.get('/api/sessions?summaries=true') as
        | Array<{ id: string; updatedAt: number }>
        | { sessions: Array<{ id: string; updatedAt: number }>; totalCount?: number };
      const pushSummaries = Array.isArray(pushRaw) ? pushRaw : pushRaw?.sessions;
      const cloudById = new Map(
        (Array.isArray(pushSummaries) ? pushSummaries : []).map(s => [s.id, s])
      );

      // Find cloud_active sessions that are missing or stale on cloud
      const { getIncrementalSessionStore } = await import('../incrementalSessionStore');
      const store = getIncrementalSessionStore();
      // Stage 2: cloud push reconciliation needs internal sessions in the local map.
      const localSummaries = store.listSessions({ includeInternal: true });
      const localById = new Map(localSummaries.map(s => [s.id, s]));

      const toPush: string[] = [];
      for (const sid of cloudActiveIds) {
        const local = localById.get(sid);
        if (!local) continue; // session no longer exists locally
        const cloud = cloudById.get(sid);
        if (!cloud || local.updatedAt > cloud.updatedAt) {
          toPush.push(sid);
        }
      }

      try {
        await this.refreshSessionTombstones(client);
      } catch (err) {
        log.warn({ err }, 'Failed to refresh tombstones before session push');
      }
      const filteredToPush = toPush.filter((sid) => !this.knownSessionTombstones.has(sid));
      if (filteredToPush.length < toPush.length) {
        const suppressed = toPush.length - filteredToPush.length;
        log.info({ suppressed }, 'Suppressed tombstoned sessions during pushSessionsToCloud');
      }

      if (filteredToPush.length === 0) {
        log.info({ direction: 'push', entity: 'sessions' }, 'Session push: cloud is up to date');
        return;
      }

      let pushed = 0;
      let failed = 0;
      let sampleError: unknown;
      for (const sid of filteredToPush) {
        try {
          const session = await store.getSession(sid);
          if (!session) continue;
          await pushFullSessionWithCapabilityGate(client, stripConversationAnnotations(session));
          markCloudSynced(sid);
          pushed++;
        } catch (err) {
          failed++;
          if (sampleError === undefined) sampleError = err;
          log.debug({ sessionId: sid, err: (err as Error).message }, 'Failed to push session to cloud');
        }
      }

      // Flush sync metadata to disk
      if (pushed > 0) {
        const { flushCloudSyncMetadata } = await import('./cloudSyncMetadata');
        flushCloudSyncMetadata();
      }

      log.info(
        { direction: 'push', entity: 'sessions', pushed, failed, total: filteredToPush.length },
        'Session push complete'
      );
      const outcome: CloudSyncOutcome = { ok: pushed, failed, authFailures: 0 };
      if (sampleError !== undefined) outcome.sampleError = sampleError;
      cloudFailureCooldown.recordCooldownVerdict(outcome);
    } catch (err) {
      recordCloudFailure(err);
      this.checkAutoRecovery();
      log.warn({ err }, 'Session push to cloud failed');
    }
  }

  /**
   * Push local inbox items to cloud using full-field reconciliation.
   * Uses `computeInboxSyncPlan()` to determine which items to push and
   * which cloud items to delete (from local tombstones).
   * Desktop is authoritative — cloud gets overwritten with local state.
   * Protected by a mutex to prevent overlapping pushes from debounce + periodic + focus triggers.
   * Fire-and-forget — errors are logged, not thrown.
   */
  async pushInboxToCloud(): Promise<void> {
    if (!cloudFailureCooldown.isAvailable()) {
      log.debug('pushInboxToCloud: skipped (failure cooldown active)');
      return;
    }
    if (this.activeInboxPushPromise) {
      log.info('pushInboxToCloud: awaiting in-progress push');
      await this.activeInboxPushPromise;
      return;
    }

    this.activeInboxPushPromise = this.executePushInbox();
    try {
      const outcome = await this.activeInboxPushPromise;
      cloudFailureCooldown.recordCooldownVerdict(outcome);
    } catch (err) {
      recordCloudFailure(err);
      this.checkAutoRecovery();
    } finally {
      this.activeInboxPushPromise = null;
    }
  }

  private async executePushInbox(): Promise<CloudSyncOutcome> {
    try {
      const client = await this.getOrCreateClient();
      if (!client) {
        log.warn('pushInboxToCloud: no cloud client available');
        return cloudSuccessOutcome();
      }

      // Fetch cloud inbox index (full shape with updatedAt, addedAt, deletedIds)
      const cloudIndex = await client.post(
        `/api/ipc/${encodeURIComponent('inbox:load-index')}`,
        { params: [] }
      ) as {
        entries?: Array<{ id: string; archived?: boolean; updatedAt?: number; addedAt: number; status?: string }>;
        deletedIds?: Array<{ id: string; deletedAt: number }>;
        history?: Array<{ id: string }>;
      } | null;

      // Load local inbox index and tombstones
      const { getInboxIndexSnapshot, getDeletedIds, computeInboxSyncPlan, readEntryFile } = await import('../inboxStore');
      const localIndex = getInboxIndexSnapshot();
      const localTombstones = getDeletedIds();
      const localHistoryIds = new Set(localIndex.history.map(h => h.id));
      const cloudEntries = Array.isArray(cloudIndex?.entries) ? cloudIndex.entries : [];
      const cloudTombstones = Array.isArray(cloudIndex?.deletedIds) ? cloudIndex.deletedIds : [];
      // Cloud history: items executed/removed on cloud — skip pushing these
      const cloudHistoryIds = new Set(
        Array.isArray(cloudIndex?.history) ? cloudIndex.history.map(h => h.id) : []
      );

      // Compute sync plan (we use toPushToCloud and toDeleteOnCloud)
      const plan = computeInboxSyncPlan(
        localIndex.entries,
        cloudEntries,
        localTombstones,
        cloudTombstones,
        localHistoryIds,
      );

      // Filter out items that are in cloud history AND local history — both
      // sides agree these are done, no need to re-push them.
      plan.toPushToCloud = plan.toPushToCloud.filter(
        id => !(cloudHistoryIds.has(id) && localHistoryIds.has(id))
      );

      // Items executed on desktop (in local history) that cloud still shows
      // as active need to be marked completed on cloud so counts converge.
      // Only target items that are genuinely active on cloud AND not also
      // active in local entries (which would mean the item was re-opened).
      const localEntryActiveIds = new Set(
        localIndex.entries
          .filter(e => !e.archived && (!e.status || e.status === 'active' || e.status === 'executing'))
          .map(e => e.id)
      );
      const historyToCompleteOnCloud: string[] = [];
      for (const cloudEntry of cloudEntries) {
        const cloudIsActive = !cloudEntry.archived && (!cloudEntry.status || cloudEntry.status === 'active' || cloudEntry.status === 'executing');
        if (cloudIsActive && localHistoryIds.has(cloudEntry.id) && !localEntryActiveIds.has(cloudEntry.id)) {
          historyToCompleteOnCloud.push(cloudEntry.id);
        }
      }

      const hasChanges = plan.toPushToCloud.length > 0 || plan.toDeleteOnCloud.length > 0 || historyToCompleteOnCloud.length > 0;
      if (!hasChanges) {
        log.info({ direction: 'push', entity: 'inbox' }, 'Inbox push: cloud is up to date');
        return cloudSuccessOutcome();
      }
      const outcome: CloudSyncOutcome = { ok: 0, failed: 0, authFailures: 0 };

      // Push items to cloud — apply index overrides for archived/status fields.
      // The index is the source of truth for these fields; entry files may be stale
      // due to normalizeAllEntryFiles or write-order issues in cleanup functions.
      const localEntryMap = new Map(localIndex.entries.map(e => [e.id, e]));
      let pushed = 0;
      let failed = 0;
      for (const id of plan.toPushToCloud) {
        const item = readEntryFile(id);
        if (!item) {
          addOutcomeFailure(outcome, `missing inbox entry file: ${id}`);
          log.warn({ id }, 'Inbox push: entry file missing for planned push item');
          continue;
        }

        // Apply index overrides (same reconciliation getInboxState() does)
        const indexEntry = localEntryMap.get(id);
        if (indexEntry) {
          item.archived = indexEntry.archived;
          if (indexEntry.status) item.status = indexEntry.status;
          if (indexEntry.archivedAt !== undefined) item.archivedAt = indexEntry.archivedAt;
          if (indexEntry.updatedAt !== undefined) item.updatedAt = indexEntry.updatedAt;
        }

        try {
          await client.post(
            `/api/ipc/${encodeURIComponent('inbox:upsert')}`,
            { params: [item] }
          );
          pushed++;
          outcome.ok += 1;
        } catch (err) {
          failed++;
          addOutcomeFailure(outcome, err);
          log.debug({ id, err: (err as Error).message }, 'Failed to push inbox item to cloud');
        }
      }

      // Delete items on cloud that were deleted locally
      let deletedOnCloud = 0;
      for (const id of plan.toDeleteOnCloud) {
        try {
          await client.post(
            `/api/ipc/${encodeURIComponent('inbox:delete')}`,
            { params: [id] }
          );
          deletedOnCloud++;
          outcome.ok += 1;
        } catch (err) {
          addOutcomeFailure(outcome, err);
          log.debug({ id, err: (err as Error).message }, 'Failed to delete inbox item on cloud');
        }
      }

      // Mark locally-executed items as completed on cloud
      let completedOnCloud = 0;
      for (const id of historyToCompleteOnCloud) {
        try {
          await client.post(
            `/api/ipc/${encodeURIComponent('inbox:set-status')}`,
            { params: [{ itemId: id, status: 'completed' }] }
          );
          completedOnCloud++;
          outcome.ok += 1;
        } catch (err) {
          addOutcomeFailure(outcome, err);
          log.debug({ id, err: (err as Error).message }, 'Failed to mark history item completed on cloud');
        }
      }

      log.info(
        { direction: 'push', entity: 'inbox', pushed, failed, deletedOnCloud, completedOnCloud, toPush: plan.toPushToCloud.length, toDelete: plan.toDeleteOnCloud.length },
        'Inbox push complete'
      );
      return outcome;
    } catch (err) {
      log.warn({ err }, 'Inbox push to cloud failed');
      throw err;
    }
  }

  /**
   * Called when the app window receives focus.
   * Triggers a background sync if cloud mode is active and debounce allows.
   */
  onAppFocused(): void {
    // Guard: only sync when cloud mode is active.
    // Use settings:update as a proxy (any channel still in CLOUD_CHANNEL_POLICIES works).
    if (!this.shouldRouteToCloud('settings:update')) return;

    // Debounce: skip if last call was < 5 seconds ago
    const now = Date.now();
    if (now - this.lastFocusedAt < 5_000) return;
    this.lastFocusedAt = now;

    // Fire-and-forget sync for sessions, settings, and inbox
    this.pullChangedSessions(this.lastSyncTimestamp).then(() => {
      this.reportCloudConnectionSuccess('focus');
    }).catch((err) => {
      log.warn({ err }, 'Background session sync on app focus failed');
    });
    this.pullSettings().then(() => {
      this.reportCloudConnectionSuccess('focus');
    }).catch((err) => {
      log.warn({ err }, 'Background settings sync on app focus failed');
    });
    this.pullInboxChanges().then(() => {
      this.reportCloudConnectionSuccess('focus');
    }).catch((err) => {
      log.warn({ err }, 'Background inbox sync on app focus failed');
    });
    // Drain outbox on focus — catches up any queued items from offline periods
    this.drainOutbox().catch((err) => {
      log.warn({ err }, 'Outbox drain on app focus failed');
    });
    // MCP config: retry if a previous push failed
    if (this.mcpConfigDirty) {
      this.syncMcpConfigToCloud();
    }
    // Staging bridge: pull any cloud-staged files created while desktop was in background
    this.triggerStagingBridgeSync();
  }

  // ---- Internal -----------------------------------------------------------

  /**
   * Run local side effects + cache writes after a successful cloud operation.
   *
   * Cloud-primary means cloud is the source of truth, but we write-through to
   * local storage so the app can restart without re-fetching everything.
   * Side effects (e.g. cleanup of upstream session mappings) that the local
   * handler would have run are also replicated here.
   */
  private async runPostCloudHooks(channel: string, args: unknown[]): Promise<void> {
    if (!this.config) return;
    try {
      switch (channel) {
        case 'sessions:upsert': {
          const session = args[0] as AgentSession;
          if (session) {
            const { getIncrementalSessionStore } = await import('../incrementalSessionStore');
            const store = getIncrementalSessionStore();
            const { getContinuityEntry, markCloudActive, touchCloudActivity } = await import('./cloudContinuityMetadata');
            const entry = getContinuityEntry(session.id);
            const writtenSession = await this.upsertSessionIfWritten(store, session);
            if (!writtenSession) {
              break;
            }
            // Reorder-only race fix: this IPC write-through path is hot, so we
            // update in-memory continuity metadata after the accepted session
            // write and rely on the normal debounced flush for persistence.
            if (entry?.state !== 'local_only') {
              markCloudActive(session.id);
              touchCloudActivity(session.id);
            }
            const { markCloudSynced } = await import('./cloudSyncMetadata');
            markCloudSynced(session.id);
            const { onSessionsSaved } = await import('../conversationIndexService');
            onSessionsSaved([writtenSession]).catch(() => {});
          }
          break;
        }
        case 'sessions:delete': {
          const payload = args[0] as { id?: string };
          if (payload?.id) {
            const { getIncrementalSessionStore } = await import('../incrementalSessionStore');
            const store = getIncrementalSessionStore();
            // Intent: 'user-delete' (Stage 3 classification table) — this is the
            // cloud-routed `sessions:delete` (genuine user intent, routed).
            await store.deleteSession(payload.id, { intent: 'user-delete' });
            const { removeCloudSyncMetadata } = await import('./cloudSyncMetadata');
            removeCloudSyncMetadata(payload.id);
            const { removeContinuityMetadata } = await import('./cloudContinuityMetadata');
            removeContinuityMetadata(payload.id);
            // Side effects the local handler would have run
            const { clearSessionApprovals } = await import('../toolSafetyService');
            clearSessionApprovals(payload.id);
          }
          break;
        }
        case 'sessions:save': {
          const sessions = args[0] as AgentSession[];
          if (Array.isArray(sessions)) {
            const { getIncrementalSessionStore } = await import('../incrementalSessionStore');
            const store = getIncrementalSessionStore();
            const { getContinuityEntry, markCloudActive, touchCloudActivity } = await import('./cloudContinuityMetadata');
            const writtenSessions = await this.upsertSessionsIfWritten(store, sessions);
            for (const s of writtenSessions) {
              const entry = getContinuityEntry(s.id);
              if (entry?.state !== 'local_only') {
                // Reorder-only race fix: keep this hot path lightweight after
                // accepted writes and let debounced metadata flush handle retries.
                markCloudActive(s.id);
                touchCloudActivity(s.id);
              }
            }
            if (writtenSessions.length === 0) {
              break;
            }
            const { markCloudSynced } = await import('./cloudSyncMetadata');
            for (const s of writtenSessions) {
              markCloudSynced(s.id);
            }
            const { onSessionsSaved } = await import('../conversationIndexService');
            onSessionsSaved(writtenSessions).catch(() => {});
          }
          break;
        }
      }
    } catch (err) {
      log.warn({ err, channel }, 'Post-cloud hook failed (cloud write succeeded)');
    }
  }

  /**
   * Hydrate local metadata from cloud IPC responses.
   *
   * When cloud data arrives via the normal IPC pull path (renderer calls
   * tool-safety:pending, memory:get-pending-approvals, etc.), the response
   * bypasses the event channel's push-path interceptors. This method ensures
   * the same local metadata registration happens regardless of how the data
   * arrived — push (WebSocket event) or pull (IPC response).
   */
  /**
   * Check if the cloud service version has changed by reading the
   * lastSeenCloudVersion from the HTTP client (set from X-Rebel-Cloud-Version
   * header on every response). If changed, trigger an immediate update check.
   */
  private checkForCloudVersionChange(): void {
    const client = this.httpClient;
    if (!client?.lastSeenCloudVersion) return;

    const current = client.lastSeenCloudVersion;
    if (this.lastKnownCloudVersion === null) {
      // First response -- seed the cache, no trigger
      this.lastKnownCloudVersion = current;
      return;
    }

    if (current !== this.lastKnownCloudVersion) {
      log.info(
        { previous: this.lastKnownCloudVersion, current },
        'Cloud version change detected via response header',
      );
      this.lastKnownCloudVersion = current;
      // Lazy import to avoid circular dependency at module load
      import('../cloudUpdateScheduler').then(({ triggerImmediateUpdateCheck }) => {
        triggerImmediateUpdateCheck();
      }).catch((err) => {
        log.warn({ err }, 'Failed to trigger immediate update check');
      });
    }
  }

  private hydrateLocalMetadata(channel: string, result: unknown): void {
    if (!Array.isArray(result)) return;

    try {
      if (channel === 'tool-safety:pending') {
        for (const approval of result) {
          if (approval && typeof approval === 'object' && approval.toolUseID) {
            this.toolApprovalInterceptor?.(approval as Record<string, unknown>);
          }
        }
      }

      if (channel === 'memory:get-pending-approvals') {
        for (const approval of result) {
          if (approval && typeof approval === 'object' && approval.toolUseId) {
            fireAndForget(this.memoryApprovalInterceptor?.(approval as Record<string, unknown>), 'cloud.cloudRouter.line2365');
          }
        }
      }
    } catch (err) {
      log.warn({ err, channel }, 'Failed to hydrate local metadata from cloud response');
    }
  }

  /**
   * Register a second ipcMain.on listener for sessions:save-sync that
   * fire-and-forgets session data to the cloud service. The primary sync
   * handler in index.ts writes to local disk, or defers behind an in-flight
   * async locked writer. If a writer is active here, wait for that local drain
   * before triggering the cloud outbox drain; the outbox reads current local
   * session state at drain time, so draining before the deferred local write
   * lands can deliver stale data and incorrectly clear the pending entry.
   * Electron supports multiple `on` listeners — the local handler is unaffected.
   */
  private registerSaveSyncForwarder(_cloudUrl: string, _cloudToken: string): void {
    this.removeSaveSyncForwarder();

    let ipcMain: typeof import('electron').ipcMain | undefined;
    try {
       
      ipcMain = (require('electron') as typeof import('electron')).ipcMain;
    } catch { /* not in Electron context (e.g. tests) */ }
    if (!ipcMain) return;

    this.saveSyncListener = (_event: unknown, sessions: unknown) => {
      fireAndForget((async () => {
      if (!Array.isArray(sessions)) return;

      const {
        isCloudActive,
        getContinuityEntry,
        markCloudActive,
        markLocalOnly,
        flushContinuityMetadata,
      } = await import('./cloudContinuityMetadata');
      const { cloudOutbox } = await import('./cloudOutbox');

      const continuityModeOn = this.shouldRouteToCloud('settings:update');

      // Demote sessions that are done, soft-deleted, or stale-empty.
      // The state map push (every 60s) signals the cloud to GC these sessions —
      // no outbox DELETE needed.
      let demoted = 0;
      for (const s of (sessions as Array<{ id?: string; doneAt?: number | null; deletedAt?: number | null; messages?: unknown[] }>)) {
        if (!s || typeof s.id !== 'string') continue;
        if (!isCloudActive(s.id)) continue;
        const demoteBecauseDone = isSessionDone(s);
        const demoteBecauseDeleted = Boolean(s.deletedAt);
        const demoteBecauseHeuristicEmpty = Boolean(s.messages && s.messages.length === 0);
        const shouldDemote = demoteBecauseDone || demoteBecauseDeleted || demoteBecauseHeuristicEmpty;
        if (shouldDemote) {
          const entry = getContinuityEntry(s.id);
          const intent = classifySavePathLocalOnlyIntent({
            existingCloudPinnedAt: entry?.cloudPinnedAt,
            demoteBecauseDone,
            demoteBecauseDeleted,
          });
          markLocalOnly(s.id, 'cloud-disabled', intent);
          demoted++;
        }
      }
      // Flush demotions to disk immediately so they survive crashes
      if (demoted > 0) {
        await flushContinuityMetadata();
      }

      const cloudActiveSessions = (sessions as Array<{ id?: string; doneAt?: number | null; deletedAt?: number | null; messages?: unknown[] }>).filter((s) => {
        if (!s || typeof s.id !== 'string') return false;
        if (!isSessionActive(s)) return false;
        if (s.deletedAt) return false;
        if (s.messages && s.messages.length === 0) return false;
        // Already cloud_active: keep syncing (carries metadata updates to cloud)
        if (isCloudActive(s.id)) return true;
        // Auto-promote active sessions in continuity mode
        if (continuityModeOn) {
          markCloudActive(s.id);
          return true;
        }
        return false;
      });
      if (cloudActiveSessions.length === 0) return;

      // Enqueue cloud_active sessions to the outbox for durable delivery.
      // The outbox deduplicates by sessionId, so repeated saves collapse to one entry.
      // touchCloudActivity prevents sessions from being auto-demoted after 14 days,
      // since desktop turns no longer go through runPostCloudHooks.
      const { touchCloudActivity } = await import('./cloudContinuityMetadata');
      for (const s of cloudActiveSessions) {
        if (s.id) {
          cloudOutbox.enqueue(s.id, 'upsert');
          touchCloudActivity(s.id);
        }
      }

      // Wait for local persistence to settle before draining the outbox: the
      // outbox re-reads `store.getSession(id)` from disk at drain time, so
      // draining before a DEFERRED quit-save lands would deliver stale state
      // and clear the entry. `hasPendingLocalSessionDrain()` (not the narrower
      // lock-hold predicate) covers the deferred-drain lifecycle, closing the
      // false-idle TOCTOU window between holder-release and deferred-body-start.
      if (hasPendingLocalSessionDrain()) {
        const localDrainFinished = await this.waitForSaveSyncLocalDrain();
        if (!localDrainFinished) {
          log.warn(
            { sessionIds: cloudActiveSessions.map((s) => s.id).filter(Boolean) },
            'Skipping immediate outbox drain after sessions:save-sync because local session persistence has not settled; durable outbox entry will retry on a later drain',
          );
          return;
        }
      }

      // Immediately drain the outbox (delivers to cloud, with backoff on failure).
      this.drainOutbox().catch((err) => {
        log.warn({ err: (err as Error).message }, 'Outbox drain after sessions:save-sync failed');
      });
      })(), 'cloudRouter.saveSyncForwarder');
    };

    ipcMain.on('sessions:save-sync', this.saveSyncListener);
    log.info('Registered sessions:save-sync cloud forwarder');
  }

  private async waitForSaveSyncLocalDrain(maxWaitMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs;
    while (hasPendingLocalSessionDrain()) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return true;
  }

  /**
   * Drain the outbox: deliver all pending cloud replication items to the cloud.
   * No-op if the HTTP client is not available (offline) or a drain is already
   * in progress (the CloudOutbox class guards this internally).
   *
   * After session delivery, triggers a throttled workspace sync (fire-and-forget)
   * to push changed workspace files to cloud. Continuity state map is pushed
   * separately on a dedicated interval (see startContinuityPushInterval).
   */
  async drainOutbox(): Promise<void> {
    if (!cloudFailureCooldown.isAvailable()) {
      log.debug('drainOutbox: skipped (failure cooldown active)');
      return;
    }
    const client = await this.getOrCreateClient();
    if (!client) return;

    const { cloudOutbox } = await import('./cloudOutbox');
    cloudOutbox.load();

    const { getBroadcastService } = await import('@core/broadcastService');
    const broadcast = getBroadcastService();

    try {
      await this.refreshSessionTombstones(client);
      const suppressed = cloudOutbox.suppressTombstonedUpserts((sessionId) => {
        const tombstone = this.knownSessionTombstones.get(sessionId);
        if (!tombstone) return false;
        if (tombstone.ttlExpiresAt <= Date.now()) {
          this.knownSessionTombstones.delete(sessionId);
          return false;
        }
        return true;
      });

      if (suppressed.length > 0) {
        for (const sessionId of suppressed) {
          this.recordTombstoneContinuityBreadcrumb({
            sessionId,
            reason: 'tombstone-applied',
            direction: 'desktop-push-suppressed-locally',
            tombstoneCount: suppressed.length,
          });
          this.recordTombstoneContinuityBreadcrumb({
            sessionId,
            reason: 'tombstone-race-detected',
            direction: 'desktop-push-suppressed-locally',
            level: 'warning',
            tombstoneCount: suppressed.length,
          });
          this.maybeEscalateTombstoneRace(sessionId, 'desktop-push-suppressed-locally');
        }
        broadcast.sendToAllWindows('cloud:outbox-changed', cloudOutbox.getStatus());
      }
    } catch (err) {
      log.warn({ err }, 'Failed to refresh/suppress tombstones before outbox drain');
    }

    try {
      const result = await cloudOutbox.drain(client, (status) => {
        broadcast.sendToAllWindows('cloud:outbox-changed', status);
      });

      // REBEL-1G8: drain() resolves even when entries fail because failures
      // are caught per-entry for retry. Feed the explicit verdict to the
      // cooldown so resolved drains cannot imply success.
      if (result.authFailures > 0) {
        log.warn(
          { authFailures: result.authFailures, failed: result.failed, sampleError: result.sampleError },
          'Outbox drain saw auth failures — recording failure to trip cloud cooldown',
        );
      } else if (result.ok === 0 && result.failed > 0) {
        log.warn(
          { failed: result.failed, sampleError: result.sampleError },
          'Outbox drain delivered 0 entries with failures — recording failure',
        );
      }

      if (result.ok > 0 || result.failed > 0 || result.authFailures > 0) {
        cloudFailureCooldown.recordCooldownVerdict(result);
        if (result.failed > 0 || result.authFailures > 0) {
          this.checkAutoRecovery();
        }
      }
      if (result.ok > 0 && result.failed === 0 && result.authFailures === 0) {
        this.reportCloudConnectionSuccess('post-drain');
      }
      // else: ok === 0 && failed === 0 && authFailures === 0 (nothing due) — no signal either way
    } catch (err) {
      recordCloudFailure(err);
      this.checkAutoRecovery();
      throw err;
    }

    // Workspace sync: push changed files to cloud (fire-and-forget, throttled)
    if (this.config) {
      const settings = this.config.getSettings();
      const coreDir = settings.coreDirectory;
      if (coreDir) {
        const { cloudWorkspaceSync } = await import('./cloudWorkspaceSync');
        cloudWorkspaceSync.syncIfNeeded(client, coreDir).catch((err) => {
          log.warn({ err }, 'Workspace sync failed');
        });
      }
    }

    // Continuity state map is pushed on a dedicated interval (not per-drain)
    // to avoid flooding. See startContinuityPushInterval().
  }

  // ---- Inbox Debounced Sync ------------------------------------------------

  /**
   * Subscribe to local inbox state changes for debounced push to cloud.
   * Fires on ALL local mutations (including bundledInboxBridge, plaudSyncService)
   * because they all call `emitInboxState`. `upsertInboxItemFromCloud` does NOT
   * call `emitInboxState`, so cloud pulls don't trigger push loops.
   */
  private subscribeInboxStateChange(): void {
    this.unsubscribeInboxStateChange?.();

    const epoch = this.connectionEpoch;
    import('../inboxStore').then(({ onInboxStateChange }) => {
      // Guard: bail if disconnect() OR a newer connection landed while the import
      // was in-flight (epoch changed) — don't install against a stale/superseded
      // connection (MA4; httpClient-only check let a delayed install register
      // against a NEWER connection).
      if (!this.httpClient || this.connectionEpoch !== epoch) return;

      this.unsubscribeInboxStateChange = onInboxStateChange(() => {
        this.scheduleDebouncedInboxPush();
      });
    }).catch((err) => {
      log.warn({ err }, 'Failed to subscribe to inbox state changes for cloud push');
    });
  }

  /**
   * Schedule a debounced push of local inbox state to cloud.
   * 15-second trailing debounce to batch rapid local mutations.
   */
  private scheduleDebouncedInboxPush(): void {
    if (this.inboxPushDebounceTimer) clearTimeout(this.inboxPushDebounceTimer);
    this.inboxPushDebounceTimer = setTimeout(() => {
      this.inboxPushDebounceTimer = null;
      this.pushInboxToCloud().catch((err) => {
        log.warn({ err }, 'Debounced inbox push to cloud failed');
      });
    }, 15_000);
  }

  /**
   * Debounced pull of inbox changes from cloud.
   * 2-second trailing debounce to avoid storms during rapid cloud mutations.
   */
  private debouncedInboxPull(): void {
    if (this.inboxPullDebounceTimer) clearTimeout(this.inboxPullDebounceTimer);
    this.inboxPullDebounceTimer = setTimeout(() => {
      this.inboxPullDebounceTimer = null;
      this.pullInboxChanges().catch((err) => {
        log.warn({ err }, 'Debounced inbox pull failed');
      });
    }, 2_000);
  }

  // ---- MCP Config Debounced Sync -------------------------------------------

  /**
   * Subscribe to MCP config changes for debounced push to cloud.
   * Fires after every `writeConfig()` in mcpConfigManager (all mutation paths).
   * Uses lazy import since mcpConfigManager is in core/ and loaded early.
   */
  private subscribeMcpConfigChange(): void {
    this.unsubscribeMcpConfigChange?.();

    const epoch = this.connectionEpoch;
    import('@core/services/mcpConfigManager').then(({ onMcpConfigChanged }) => {
      // Guard: bail if disconnect() OR a newer connection landed while the import
      // was in-flight (epoch changed) — don't install against a stale/superseded
      // connection (MA4; same pattern as subscribeInboxStateChange).
      if (!this.httpClient || this.connectionEpoch !== epoch) return;

      this.unsubscribeMcpConfigChange = onMcpConfigChanged(() => {
        this.scheduleDebouncedMcpConfigSync();
      });
    }).catch((err) => {
      log.warn({ err }, 'Failed to subscribe to MCP config changes for cloud sync');
    });
  }

  /**
   * Schedule a debounced push of MCP config to cloud.
   * 500ms trailing debounce to collapse batch operations (e.g., adding 8 split Rebel MCPs).
   */
  private scheduleDebouncedMcpConfigSync(): void {
    if (!this.isCloudModeActive()) return;
    if (this.mcpSyncDebounceTimer) clearTimeout(this.mcpSyncDebounceTimer);
    this.mcpSyncDebounceTimer = setTimeout(() => {
      this.mcpSyncDebounceTimer = null;
      this.syncMcpConfigToCloud();
    }, 500);
  }

  /**
   * Push the resolved MCP config to cloud. Serialized via in-flight mutex
   * to prevent overlapping PUT requests that cause restart thrash on cloud.
   *
   * If a push is already in flight and a NEW config change arrives (via
   * `scheduleDebouncedMcpConfigSync()`), we set `mcpConfigDirtyNewChange`
   * so the `.finally()` block reschedules. Failure-driven dirty is tracked
   * separately via `mcpConfigDirty` and retried only on focus/reconnect —
   * never auto-rescheduled, to prevent infinite 500ms retry loops.
   */
  private mcpConfigDirtyNewChange = false;

  private syncMcpConfigToCloud(): void {
    if (this.mcpSyncInFlight) {
      this.mcpConfigDirtyNewChange = true; // New change arrived — will sync after current push
      return;
    }

    this.mcpSyncInFlight = this.doSyncMcpConfigToCloud();
    fireAndForget(this.mcpSyncInFlight
      .finally(() => {
        this.mcpSyncInFlight = null;
        // Only reschedule if a NEW config change arrived during the push.
        // Failure-driven dirty flag is NOT rescheduled — retried on focus/reconnect.
        if (this.mcpConfigDirtyNewChange) {
          this.mcpConfigDirtyNewChange = false;
          this.scheduleDebouncedMcpConfigSync();
        }
      }), 'cloud.cloudRouter.line2688');
  }

  /**
   * Execute the actual MCP config push to cloud.
   * Reads the resolved config (flattened, with OAuth tokens) and PUTs to /api/mcp/config.
   */
  private async doSyncMcpConfigToCloud(): Promise<void> {
    const client = await this.getOrCreateClient();
    if (!client) return;
    if (!this.config) return;

    try {
      const settings = this.config.getSettings();
      const { readAndMergeMcpConfig } = await import('./cloudMigrationService');
      const payload = await readAndMergeMcpConfig(settings);
      if (!payload) {
        // No MCP config to sync (no servers configured) — clear dirty flag
        this.mcpConfigDirty = false;
        return;
      }
      await client.put('/api/mcp/config', payload);
      this.mcpConfigDirty = false;
      log.info({ serverCount: Object.keys(payload.config?.mcpServers ?? {}).length }, 'MCP config synced to cloud');
    } catch (err) {
      this.mcpConfigDirty = true;
      log.warn({ err }, 'Failed to sync MCP config to cloud — will retry on focus/reconnect');
    }
  }

  // ---- Lifecycle Check ----------------------------------------------------

  /** 14 days in milliseconds. */
  private static readonly STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1_000;

  /**
   * Check for stale cloud_active sessions and demote them.
   *
   * Sessions that are cloud_active, not pinned, and have lastCloudActivityAt
   * older than 14 days are demoted to local_only. The next state map push
   * will signal the cloud to GC them — no outbox DELETE needed.
   *
   * Sessions with `lastCloudActivityAt === undefined` are NOT stale (protects
   * migrated sessions from mass demotion).
   */
  private async runLifecycleCheck(): Promise<void> {
    if (!this.firstPullCompleted) {
      log.debug('Lifecycle check deferred — first pull not yet completed');
      return;
    }
    try {
      const { getStaleCloudSessions, markLocalOnly, flushContinuityMetadata } = await import('./cloudContinuityMetadata');
      const stale = getStaleCloudSessions(CloudRouter.STALE_THRESHOLD_MS);
      if (stale.length === 0) return;

      for (const sessionId of stale) {
        markLocalOnly(sessionId, 'cloud-disabled', 'retention-policy');
      }

      // Flush demotions to disk immediately so they survive crashes
      await flushContinuityMetadata();

      log.info({ demoted: stale.length }, 'Lifecycle check: demoted stale cloud sessions');

      // Broadcast continuity change so renderer can update
      const { getBroadcastService } = await import('@core/broadcastService');
      getBroadcastService().sendToAllWindows('cloud:continuity-changed', {});
    } catch (err) {
      log.warn({ err }, 'Lifecycle check failed');
    }
  }

  /**
   * Push the full continuity state map to cloud.
   * Desktop is authoritative — cloud stores it, mobile/web reads it to filter sessions.
   *
   * Enriches the explicit continuity metadata with `local_only` entries for all
   * known desktop sessions that don't have an explicit entry. This prevents the
   * cloud-service from treating "missing" sessions as cloud-native (and showing
   * them to mobile/web).
   */
  private async pushContinuityStateMap(client: CloudServiceClientType, force = false): Promise<void> {
    if (!cloudFailureCooldown.isAvailable()) {
      log.debug('pushContinuityStateMap: skipped (failure cooldown active)');
      return;
    }
    const { getAllContinuityStates } = await import('./cloudContinuityMetadata');
    const stateMap: ContinuityStateMap = { ...getAllContinuityStates() };

    // Enrich: add explicit local_only entries for all known desktop sessions
    // that don't have an explicit continuity entry. This prevents the cloud-service
    // from treating "missing" sessions as cloud-native.
    // Important: default to 'local_only' here, NOT getContinuityState() which
    // falls back to isCloudSynced() (backward-compat inference). Sessions that
    // were bulk-synced historically but never explicitly opted in should not
    // appear on mobile/web.
    const { getIncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = getIncrementalSessionStore();
    const sessionIds = store.getSessionIds();
    if (sessionIds.length === 0) {
      // Cold-start guard: getSessionIds() returns [] if index not loaded.
      // Fall back to listSessions() which lazy-loads the index.
      // Continuity state computation is a non-UI path and must include internal sessions.
      const allSessions = store.listSessions({ includeInternal: true });
      for (const summary of allSessions) {
        if (summary.id && !stateMap[summary.id]) {
          stateMap[summary.id] = { state: 'local_only' };
        }
      }
    } else {
      for (const id of sessionIds) {
        if (!stateMap[id]) {
          stateMap[id] = { state: 'local_only' };
        }
      }
    }

    let withUserIntent = 0;
    let withRetentionIntent = 0;
    let inferredOnly = 0;
    for (const entry of Object.values(stateMap)) {
      if (entry.cloudRemovalIntent?.requestedBy === 'user') {
        withUserIntent++;
        continue;
      }
      if (entry.cloudRemovalIntent?.requestedBy === 'retention-policy') {
        withRetentionIntent++;
        continue;
      }
      if (entry.state === 'local_only') {
        inferredOnly++;
      }
    }

    // Fingerprint-based skip: only for periodic (non-force) pushes.
    const fingerprint = this.computeContinuityFingerprint(stateMap);
    if (!force && fingerprint === this.lastContinuityFingerprint) {
      this.continuityUnchangedCycles++;
      if (this.continuityUnchangedCycles === CloudRouter.CONTINUITY_BACKOFF_THRESHOLD) {
        log.debug({ cycles: this.continuityUnchangedCycles }, 'pushContinuityStateMap: backing off to 5-min interval');
        this.restartContinuityPushInterval(CloudRouter.CONTINUITY_PUSH_BACKOFF_MS);
      }
      log.debug({ entries: Object.keys(stateMap).length }, 'pushContinuityStateMap: skipped (unchanged)');
      return;
    }

    try {
      await client.put('/api/continuity/state', stateMap);
      cloudFailureCooldown.recordCooldownVerdict(cloudSuccessOutcome());
      this.lastContinuityFingerprint = fingerprint;
      this.continuityUnchangedCycles = 0;
      this.restartContinuityPushInterval(CloudRouter.CONTINUITY_PUSH_INTERVAL_MS);
      log.info(
        {
          entries: Object.keys(stateMap).length,
          withUserIntent,
          withRetentionIntent,
          inferredOnly,
          fingerprintChanged: true,
        },
        'Pushed continuity state map to cloud',
      );
    } catch (err) {
      recordCloudFailure(err);
      // Invalidate fingerprint cache on failure so recovery pushes aren't
      // skipped by a stale match (e.g., after server-side state loss).
      this.lastContinuityFingerprint = null;
      throw err;
    }
  }

  /**
   * Compute a stable fingerprint of the continuity state map.
   * Sorts keys for determinism regardless of insertion order.
   */
  private computeContinuityFingerprint(stateMap: Record<string, unknown>): string {
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const sorted = Object.keys(stateMap).sort().reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = stateMap[key];
      return acc;
    }, {});
    return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
  }

  /**
   * Force an immediate workspace sync to cloud, bypassing the 5-minute throttle.
   * Returns success flag and push statistics. Used by the IPC handler.
   */
  async forceWorkspaceSync(): Promise<{ success: boolean; pushed?: number; skipped?: number; failed?: number; error?: string }> {
    const client = await this.getOrCreateClient();
    if (!client) {
      return { success: false, error: 'Cloud not connected' };
    }
    if (!this.config) {
      return { success: false, error: 'Cloud router not initialized' };
    }

    const settings = this.config.getSettings();
    const coreDir = settings.coreDirectory;
    if (!coreDir) {
      return { success: false, error: 'No workspace directory configured' };
    }

    try {
      const { cloudWorkspaceSync } = await import('./cloudWorkspaceSync');
      const result = await cloudWorkspaceSync.forceSync(client, coreDir);
      return { success: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err }, 'Force workspace sync failed');
      return { success: false, error: message };
    }
  }

  /**
   * Apply ONE user-requested "pending cloud update" — fast-forward a single
   * Drive/Dropbox/iCloud-owned file to the newer version that exists only in
   * Rebel's cloud (edited on phone/web). Owns the client + workspace lookup;
   * defers the read/write/record/clear to {@link CloudWorkspaceSync.applyPendingCloudUpdate}.
   * Mirrors {@link forceWorkspaceSync}. REBEL-696 Stage 5 (Option A).
   */
  async applyPendingCloudUpdate(
    relativePath: string,
  ): Promise<import('./cloudWorkspaceSync').ApplyPendingCloudUpdateResult> {
    const client = await this.getOrCreateClient();
    if (!client) {
      return { success: false, reason: 'cloud_offline', error: "Couldn't update that file. Try again." };
    }
    if (!this.config) {
      return { success: false, reason: 'not_configured', error: "Couldn't update that file. Try again." };
    }

    const coreDir = this.config.getSettings().coreDirectory;
    if (!coreDir) {
      return { success: false, reason: 'not_configured', error: "Couldn't update that file. Try again." };
    }

    const { cloudWorkspaceSync } = await import('./cloudWorkspaceSync');
    return cloudWorkspaceSync.applyPendingCloudUpdate(client, coreDir, relativePath);
  }

  /**
   * User-initiated "Sync now" — runs a full incremental sync across all domains.
   * Mirrors onAppFocused() but adds push phases + workspace force sync.
   * Returns workspace stats and coarse success/failure.
   *
   * Workspace conflicts are broadcast separately via `cloud:workspace-conflicts`
   * (handled by the existing onWorkspaceConflicts listener in the renderer).
   */
  private syncNowInProgress = false;

  async syncNow(): Promise<{
    success: boolean;
    workspace: { pushed: number; skipped: number; failed: number };
    error?: string;
  }> {
    if (this.syncNowInProgress) {
      return { success: false, workspace: { pushed: 0, skipped: 0, failed: 0 }, error: 'Sync already in progress' };
    }

    if (!this.shouldRouteToCloud('settings:update')) {
      return { success: false, workspace: { pushed: 0, skipped: 0, failed: 0 }, error: 'Cloud mode not active' };
    }

    this.syncNowInProgress = true;
    const errors: string[] = [];
    let workspace = { pushed: 0, skipped: 0, failed: 0 };

    try {
      // 1. Pull sessions from cloud
      try {
        await this.pullChangedSessions();
      } catch (err) {
        log.warn({ err }, 'syncNow: pull sessions failed');
        errors.push('session pull');
      }

      // 2. Push local cloud_active sessions
      try {
        await this.pushSessionsToCloud();
      } catch (err) {
        log.warn({ err }, 'syncNow: push sessions failed');
        errors.push('session push');
      }

      // 3. Pull inbox changes
      try {
        await this.pullInboxChanges();
      } catch (err) {
        log.warn({ err }, 'syncNow: pull inbox failed');
        errors.push('inbox pull');
      }

      // 4. Push inbox to cloud
      try {
        await this.pushInboxToCloud();
      } catch (err) {
        log.warn({ err }, 'syncNow: push inbox failed');
        errors.push('inbox push');
      }

      // 5. Force workspace sync (returns push stats)
      try {
        const wsResult = await this.forceWorkspaceSync();
        if (wsResult.success) {
          workspace = {
            pushed: wsResult.pushed ?? 0,
            skipped: wsResult.skipped ?? 0,
            failed: wsResult.failed ?? 0,
          };
        } else {
          errors.push(wsResult.error ?? 'workspace sync');
        }
      } catch (err) {
        log.warn({ err }, 'syncNow: workspace sync failed');
        errors.push('workspace sync');
      }

      // 6. Push settings and continuity to cloud
      const client = await this.getOrCreateClient();
      if (client && this.config) {
        try {
          await this.forwardSettingsUpdate(client, [this.config.getSettings()]);
        } catch (err) {
          log.warn({ err }, 'syncNow: settings push failed');
          errors.push('settings push');
        }

        try {
          await this.pushContinuityStateMap(client, true);
        } catch (err) {
          log.warn({ err }, 'syncNow: continuity state map push failed');
          errors.push('continuity push');
        }

        // Codex OAuth tokens (fire-and-forget; logs on error)
        try {
          const { loadCodexTokens } = await import('@core/services/codexTokenStorage');
          await this.pushCodexTokens(loadCodexTokens(), { source: 'sync' });
        } catch (err) {
          log.warn({ err }, 'syncNow: Codex token push failed');
          errors.push('codex token push');
        }

        // Managed (Mindstone subscription) OpenRouter key: re-push current state
        // on manual/full sync so an already-provisioned desktop key (or a
        // pending revoke-clear) reaches cloud even if it predates pairing and
        // no reconnect has fired. Sync semantics: transient read-null does not
        // clear; a durable pending-clear still replays.
        try {
          await this.pushCurrentManagedKey();
        } catch (err) {
          log.warn({ err }, 'syncNow: managed key relay failed');
          errors.push('managed key relay');
        }
      }

      // 7. Drain outbox (final flush)
      try {
        await this.drainOutbox();
      } catch (err) {
        log.warn({ err }, 'syncNow: outbox drain failed');
        errors.push('outbox drain');
      }

      // 8. Trigger staging bridge sync (non-critical)
      try {
        this.triggerStagingBridgeSync();
      } catch { /* fire-and-forget */ }

      const success = errors.length === 0;
      log.info({ success, errors, workspace }, 'syncNow: complete');

      return {
        success,
        workspace,
        error: errors.length > 0 ? `Partial failure: ${errors.join(', ')}` : undefined,
      };
    } finally {
      this.syncNowInProgress = false;
    }
  }

  /**
   * Immediately sync a session's continuity state change to cloud.
   * Called when the user toggles "Keep in cloud" / "Remove from cloud".
   *
   * For cloud_active: enqueues session upsert and drains.
   * For local_only: pushes the state map immediately — the cloud-side GC
   * handles deletion based on the state map (no outbox DELETE needed).
   */
  async syncContinuityChange(sessionId: string, state: 'local_only' | 'cloud_active'): Promise<void> {
    if (state === 'cloud_active') {
      const { cloudOutbox } = await import('./cloudOutbox');
      cloudOutbox.enqueue(sessionId, 'upsert');
      await this.drainOutbox();
    }
    // Push state map immediately for user-initiated changes (bypass interval).
    // For local_only, this is the primary cleanup signal to cloud.
    const client = await this.getOrCreateClient();
    if (client) {
      this.pushContinuityStateMap(client, true).catch((err) => {
        log.warn({ err }, 'Continuity state map push after state change failed');
      });
    }
  }

  /**
   * One-time cleanup: demote cloud_active sessions that are not currently
   * active on desktop. Historical migrations mass-promoted sessions; the
   * correct default is local_only. Gated by a flag file so it runs once.
   *
   * Heuristic: Active sessions (doneAt null/absent) stay cloud_active (user
   * actively uses them). Done sessions are demoted to local_only.
   */
  private async runOneTimeContinuityCleanup(): Promise<void> {
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { getDataPath } = await import('../../utils/dataPaths');
      const flagPath = path.join(getDataPath(), 'sessions', 'continuity-v2-cleanup-done');

      if (fs.existsSync(flagPath)) return;

      const { loadContinuityMetadata, getAllContinuityStates, markLocalOnly } = await import('./cloudContinuityMetadata');
      loadContinuityMetadata();
      const stateMap = getAllContinuityStates();
      const cloudActiveIds = Object.entries(stateMap)
        .filter(([, entry]) => entry.state === 'cloud_active')
        .map(([id]) => id);

      if (cloudActiveIds.length === 0) {
        fs.mkdirSync(path.dirname(flagPath), { recursive: true });
        fs.writeFileSync(flagPath, new Date().toISOString(), 'utf8');
        return;
      }

      const { getIncrementalSessionStore } = await import('../incrementalSessionStore');
      const store = getIncrementalSessionStore();
      // One-time continuity cleanup audits all known sessions, including internal ones.
      const summaries = store.listSessions({ includeInternal: true });
      const activeIds = new Set(
        summaries.filter((s) => isSessionActive(s)).map((s) => s.id),
      );

      let demoted = 0;
      for (const sessionId of cloudActiveIds) {
        if (activeIds.has(sessionId)) continue;
        markLocalOnly(sessionId, 'cloud-disabled', 'retention-policy');
        demoted++;
      }

      fs.mkdirSync(path.dirname(flagPath), { recursive: true });
      fs.writeFileSync(flagPath, new Date().toISOString(), 'utf8');

      if (demoted > 0) {
        const { flushContinuityMetadata } = await import('./cloudContinuityMetadata');
        await flushContinuityMetadata();
        // The next state map push will signal the cloud to GC these sessions
        log.info({ demoted, kept: cloudActiveIds.length - demoted }, 'One-time continuity cleanup: demoted done sessions');
        const { getBroadcastService } = await import('@core/broadcastService');
        getBroadcastService().sendToAllWindows('cloud:continuity-changed', {});
      }
    } catch (err) {
      log.warn({ err }, 'One-time continuity cleanup failed');
    }
  }

  private clearLifecycleInterval(): void {
    if (this.lifecycleInterval) {
      clearInterval(this.lifecycleInterval);
      this.lifecycleInterval = null;
    }
  }

  private clearInboxSyncInterval(): void {
    if (this.inboxSyncInterval) {
      clearInterval(this.inboxSyncInterval);
      this.inboxSyncInterval = null;
    }
  }

  private startContinuityPushInterval(): void {
    this.clearContinuityPushInterval();
    this.continuityUnchangedCycles = 0;
    this.restartContinuityPushInterval(CloudRouter.CONTINUITY_PUSH_INTERVAL_MS);
  }

  /**
   * (Re)start the continuity push interval with the given timing.
   * Used internally to switch between normal (60s) and backed-off (5min) intervals.
   */
  private restartContinuityPushInterval(intervalMs: number): void {
    if (this.continuityPushInterval) {
      clearInterval(this.continuityPushInterval);
    }
    this.continuityPushInterval = setInterval(() => {
      fireAndForget(this.getOrCreateClient().then(client => {
        if (client) this.pushContinuityStateMap(client).catch(err => {
          log.warn({ err }, 'Interval continuity state map push failed');
        });
      }), 'cloud.cloudRouter.line3155');
    }, intervalMs);
  }

  private clearContinuityPushInterval(): void {
    if (this.continuityPushInterval) {
      clearInterval(this.continuityPushInterval);
      this.continuityPushInterval = null;
    }
  }

  /**
   * Subscribe to workspace watcher events for near-real-time desktop→cloud sync.
   * On any file event, schedules a debounced workspace sync via `syncSoon()`.
   * Uses stored listener refs for safe cleanup (never removeAllListeners on shared emitter).
   */
  private subscribeWorkspaceWatcher(): void {
    // Clean up any existing subscription first (idempotency)
    this.unsubscribeWorkspaceWatcher();

    const epoch = this.connectionEpoch;
    const triggerSync = (): void => {
      if (!this.config || !this.httpClient) return;
      const settings = this.config.getSettings();
      const coreDir = settings.coreDirectory;
      if (!coreDir) return;

      import('./cloudWorkspaceSync').then(({ cloudWorkspaceSync }) => {
        // httpClient may have been nulled between the event and the import resolution
        if (this.httpClient) {
          cloudWorkspaceSync.syncSoon(this.httpClient, coreDir);
        }
      }).catch((err) => {
        log.warn({ err }, 'Failed to schedule workspace sync from watcher event');
      });
    };

    this.workspaceWatcherListeners = {
      fileAdded: () => triggerSync(),
      fileChanged: () => triggerSync(),
      fileRemoved: () => triggerSync(),
    };

    import('../workspaceWatcherService').then(({ workspaceWatcherService }) => {
      // Guard: bail if listeners were cleared by disconnect() OR a newer connection
      // landed while the import was in-flight (epoch changed) — avoids registering
      // (and leaking) a stale/superseded connection's listeners on the shared
      // emitter (MA4).
      if (!this.workspaceWatcherListeners || this.connectionEpoch !== epoch) return;
      workspaceWatcherService.on('file:added', this.workspaceWatcherListeners.fileAdded);
      workspaceWatcherService.on('file:changed', this.workspaceWatcherListeners.fileChanged);
      workspaceWatcherService.on('file:removed', this.workspaceWatcherListeners.fileRemoved);
      log.info('Subscribed to workspace watcher for cloud sync');
    }).catch((err) => {
      log.warn({ err }, 'Failed to subscribe workspace watcher for cloud sync');
    });
  }

  /**
   * Unsubscribe from workspace watcher events and clear syncSoon timers.
   */
  private unsubscribeWorkspaceWatcher(): void {
    if (this.workspaceWatcherListeners) {
      const listeners = this.workspaceWatcherListeners;
      this.workspaceWatcherListeners = null;

      import('../workspaceWatcherService').then(({ workspaceWatcherService }) => {
        workspaceWatcherService.off('file:added', listeners.fileAdded);
        workspaceWatcherService.off('file:changed', listeners.fileChanged);
        workspaceWatcherService.off('file:removed', listeners.fileRemoved);
        log.info('Unsubscribed from workspace watcher for cloud sync');
      }).catch((err) => {
        log.warn({ err }, 'Failed to unsubscribe workspace watcher');
      });
    }

    // Clear any pending syncSoon timers
    import('./cloudWorkspaceSync').then(({ cloudWorkspaceSync }) => {
      cloudWorkspaceSync.clearSyncSoonTimers();
    }).catch(() => { /* best-effort cleanup */ });
  }

  /**
   * Trigger a staging bridge sync to pull cloud-staged .pending.md files.
   * Fire-and-forget — errors are logged, not thrown.
   */
  private triggerStagingBridgeSync(): void {
    if (!this.httpClient || !this.config) return;
    const settings = this.config.getSettings();
    const coreDir = settings.coreDirectory;
    if (!coreDir) return;

    import('./cloudStagingBridge').then(({ syncCloudStagedFiles }) => {
      if (this.httpClient) {
        syncCloudStagedFiles(this.httpClient, coreDir).catch((err) => {
          log.warn({ err }, 'Initial staging bridge sync failed');
        });
      }
    }).catch((err) => {
      log.warn({ err }, 'Failed to import staging bridge');
    });
  }

  /**
   * Clear staging bridge debounce timers. Call on disconnect.
   */
  private clearStagingBridgeTimers(): void {
    import('./cloudStagingBridge').then(({ clearStagingSyncTimers }) => {
      clearStagingSyncTimers();
    }).catch(() => { /* best-effort cleanup */ });
  }

  private removeSaveSyncForwarder(): void {
    if (this.saveSyncListener) {
      let ipcMain: typeof import('electron').ipcMain | undefined;
      try {
         
        ipcMain = (require('electron') as typeof import('electron')).ipcMain;
      } catch { /* not in Electron context */ }
      if (ipcMain) {
        ipcMain.removeListener('sessions:save-sync', this.saveSyncListener);
      }
      this.saveSyncListener = null;
      log.info('Removed sessions:save-sync cloud forwarder');
    }
  }

  /**
   * Get or lazily create the bridge client from current settings.
   */
  private async getOrCreateClient(): Promise<CloudServiceClientType | null> {
    if (this.httpClient) return this.httpClient;

    if (!this.config) return null;

    const settings = this.config.getSettings();
    const cloudInstance = settings.cloudInstance;

    if (!cloudInstance?.cloudUrl || !cloudInstance?.cloudToken) return null;

    const { CloudServiceClient } = await loadCloudClient();
    this.httpClient = new CloudServiceClient(cloudInstance.cloudUrl, cloudInstance.cloudToken);
    return this.httpClient;
  }

  /**
   * Forward settings:get with local-only field merge.
   *
   * Cloud settings are the source of truth for everything except local-only
   * fields (cloudInstance, coreDirectory, mcpConfigFile), which stay local.
   */
  private async forwardSettingsGet(
    client: CloudServiceClientType,
  ): Promise<unknown> {
    const cloudSettings = await client.get('/api/settings') as Record<string, unknown>;

    if (this.config) {
      const localSettings = this.config.getSettings();

      try {
        const drifts = detectSettingsDrift(localSettings as AppSettings, cloudSettings as AppSettings);
        const emission = consumeSettingsDriftEmissionDecision(drifts, desktopSettingsDriftEmissionCache);
        if (emission.shouldEmit) {
          for (const drift of emission.observations) {
            appendDiagnosticEvent({
              kind: 'settings_drift_observation',
              data: {
                ...drift,
                eventState: emission.eventState,
                surfaceA: 'desktop',
                surfaceB: 'cloud',
              },
            });
          }
        }
      } catch (err) {
        log.warn({ err }, 'Failed to detect or emit settings drift');
      }

      return mergeLocalSettings(cloudSettings, localSettings as Record<string, unknown>);
    }

    return cloudSettings;
  }

  /**
   * Forward settings:update, stripping local-only fields before sending to cloud.
   *
   * Local-only fields (cloudInstance, coreDirectory, mcpConfigFile) must never
   * be sent to the cloud. We strip them before forwarding, and merge them back
   * into the response from local settings.
   */
  private async forwardSettingsUpdate(
    client: CloudServiceClientType,
    args: unknown[],
  ): Promise<unknown> {
    const settings = args[0] as Record<string, unknown>;
    if (!settings || typeof settings !== 'object') {
      return { error: { code: 'INVALID_ARGS', message: 'settings:update requires a settings object' } };
    }

    // Strip local-only settings before forwarding to cloud
    const cloudSettings = stripLocalSettings(settings);

    // Forward non-local settings to the cloud
    const result = await client.patch('/api/settings', cloudSettings);

    // Merge local-only fields back for the response
    if (this.config) {
      const local = this.config.getSettings();
      return mergeLocalSettings(result as Record<string, unknown>, local as Record<string, unknown>);
    }

    return result;
  }

  /**
   * Push Codex OAuth tokens to the user's cloud instance.
   *
   * Called by `codexTokenEvents.on('changed', …)` in main/index.ts after
   * desktop logs in, refreshes, or logs out. Fire-and-forget: failures are
   * logged but never thrown to the auth flow (tokens stay valid locally
   * regardless, and we'll retry on next reconnect via the reconnect hook).
   *
   * @param tokens - current desktop tokens, or null to clear cloud tokens
   */
  async pushCodexTokens(tokens: unknown, options: { source: CodexTokenPushSource }): Promise<void> {
    // Eager-mark BEFORE any config/client checks or the POST: if the app exits
    // while a mutation-null push is in flight (logout-then-quit with cloud
    // unreachable), the durable marker must already exist so the clear intent
    // replays after restart. Confirmed delivery below clears it; observed
    // failures refine the reason.
    if (options.source === 'mutation' && tokens === null) {
      markPendingCodexCloudClear('mutation_in_flight');
    }
    const hasTokensNow = tokens !== null;
    const hadTokensPreviously = this.lastObservedCodexTokensPresent === true;
    this.lastObservedCodexTokensPresent = hasTokensNow;

    const hasPendingClear = hasPendingCodexCloudClear();
    const shouldReplayPendingClear = options.source === 'sync' && tokens === null && hasPendingClear;
    const shouldEmitMeaningfulSyncNullSkip = options.source === 'sync' && tokens === null && (hasPendingClear || hadTokensPreviously);

    const surface: 'desktop' | 'unknown' =
      process.env.REBEL_SURFACE === 'desktop' ? 'desktop' : 'unknown';
    const conditionPayload = {
      cause: 'sync_null_deletion_attempted' as const,
      source: 'cloud_router_sync_guard' as const,
      surface,
    };

    if (!this.config) {
      if (options.source === 'mutation' && tokens === null) {
        markPendingCodexCloudClear('mutation_skipped_no_config');
        log.warn({ source: options.source }, 'Skipped Codex null push because cloud router is unconfigured; pending clear marker persisted');
      } else if (shouldEmitMeaningfulSyncNullSkip) {
        log.warn(conditionPayload, 'Skipping sync-source null Codex token push while cloud router is unconfigured');
        captureKnownCondition(
          'codex_auth_destructive_disconnect',
          conditionPayload,
          new Error('sync-source codex token read returned null while cloud router unconfigured'),
        );
      } else if (options.source === 'sync' && tokens === null) {
        log.debug(
          { source: options.source },
          'Skipping sync-source null Codex token push (no pending clear marker and no prior token observation)',
        );
      }
      return;
    }
    const client = await this.getOrCreateClient();
    if (!client) {
      if (options.source === 'mutation' && tokens === null) {
        markPendingCodexCloudClear('mutation_skipped_no_client');
        log.warn({ source: options.source }, 'Skipped Codex null push because cloud client is unavailable; pending clear marker persisted');
      } else if (shouldEmitMeaningfulSyncNullSkip) {
        log.warn(conditionPayload, 'Skipping sync-source null Codex token push while cloud client is unavailable');
        captureKnownCondition(
          'codex_auth_destructive_disconnect',
          conditionPayload,
          new Error('sync-source codex token read returned null while cloud client unavailable'),
        );
      } else if (options.source === 'sync' && tokens === null) {
        log.debug(
          { source: options.source },
          'Skipping sync-source null Codex token push (no pending clear marker and no prior token observation)',
        );
      }
      return;
    }

    if (options.source === 'sync' && tokens === null && !hasPendingClear) {
      if (hadTokensPreviously) {
        log.warn(conditionPayload, 'Skipping sync-source null Codex token push to avoid unintended cloud token deletion');
        captureKnownCondition(
          'codex_auth_destructive_disconnect',
          conditionPayload,
          new Error('sync-source codex token read returned null after prior non-null observation'),
        );
      } else {
        log.debug(
          { source: options.source },
          'Skipping sync-source null Codex token push (no pending clear marker and no prior token observation)',
        );
      }
      return;
    }

    try {
      await client.post('/api/codex/tokens', { tokens });
      if (tokens !== null || options.source === 'mutation' || shouldReplayPendingClear) {
        clearPendingCodexCloudClear();
      }
      log.info(
        { hasTokens: tokens !== null, source: options.source, replayedPendingClear: shouldReplayPendingClear },
        'Codex tokens pushed to cloud',
      );
    } catch (err) {
      if (options.source === 'mutation' && tokens === null) {
        markPendingCodexCloudClear('mutation_post_failed');
      }
      log.warn({ err }, 'Codex token push to cloud failed (non-fatal — desktop tokens still valid)');
    }
  }

  /**
   * Relay the managed (Mindstone subscription) OpenRouter key to the user's
   * cloud instance.
   *
   * Mirrors `pushCodexTokens` exactly (auth, fire-and-forget, destructive-null
   * guard, durable pending-clear marker), so that mobile turns — which execute
   * on cloud-service — can resolve the same managed subscription that works on
   * desktop. The cloud proxy resolves the key out-of-band from its store once
   * written (see cloud-service Layer 3a), so this relay is the last piece.
   *
   * Triggered:
   * - on desktop save/clear/revoke (`source: 'mutation'`, from authService), and
   * - on cloud reconnect (`source: 'sync'`, re-pushing the current stored key).
   *
   * UNCONDITIONAL: no `managedCloudEnabled` gate (per the 2026-06-23 user
   * decision — relay whenever the key is saved/cleared, both Mindstone-hosted
   * and self-hosted). The only precondition is that a cloud instance is
   * actually configured/paired — enforced by `getOrCreateClient()` returning a
   * client (same as codex). The key is NEVER logged (presence only).
   *
   * @param apiKey - the managed key to relay, or null to clear it on cloud.
   */
  async pushManagedOpenRouterKey(
    apiKey: string | null,
    options: { source: ManagedKeyPushSource },
  ): Promise<void> {
    // Eager-mark BEFORE any config/client checks or the POST: if the app exits
    // while a mutation-null relay (clear/revoke) is in flight with cloud
    // unreachable, the durable marker must already exist so the clear intent
    // replays after restart. Confirmed delivery clears it; observed failures
    // refine the reason. Mirrors pushCodexTokens.
    if (options.source === 'mutation' && apiKey === null) {
      markPendingManagedKeyCloudClear('mutation_in_flight');
    }
    const hasKeyNow = apiKey !== null;
    const hadKeyPreviously = this.lastObservedManagedKeyPresent === true;
    this.lastObservedManagedKeyPresent = hasKeyNow;

    const hasPendingClear = hasPendingManagedKeyCloudClear();
    const shouldReplayPendingClear = options.source === 'sync' && apiKey === null && hasPendingClear;
    const shouldEmitMeaningfulSyncNullSkip =
      options.source === 'sync' && apiKey === null && (hasPendingClear || hadKeyPreviously);

    if (!this.config) {
      if (options.source === 'mutation' && apiKey === null) {
        markPendingManagedKeyCloudClear('mutation_skipped_no_config');
        log.warn({ source: options.source }, 'Skipped managed key null relay because cloud router is unconfigured; pending clear marker persisted');
      } else if (shouldEmitMeaningfulSyncNullSkip) {
        log.warn({ source: options.source }, 'Skipping sync-source null managed key relay while cloud router is unconfigured');
      }
      return;
    }
    const client = await this.getOrCreateClient();
    if (!client) {
      if (options.source === 'mutation' && apiKey === null) {
        markPendingManagedKeyCloudClear('mutation_skipped_no_client');
        log.warn({ source: options.source }, 'Skipped managed key null relay because cloud client is unavailable; pending clear marker persisted');
      } else if (shouldEmitMeaningfulSyncNullSkip) {
        log.warn({ source: options.source }, 'Skipping sync-source null managed key relay while cloud client is unavailable');
      }
      return;
    }

    // Destructive-null guard: a transient desktop read returning null on a
    // sync re-push must NOT relay a clear that would wipe a still-valid cloud
    // key. Only relay a sync-source null when a genuine clear intent is pending.
    if (options.source === 'sync' && apiKey === null && !hasPendingClear) {
      if (hadKeyPreviously) {
        log.warn({ source: options.source }, 'Skipping sync-source null managed key relay to avoid unintended cloud key deletion');
      }
      return;
    }

    try {
      await client.post('/api/openrouter/managed-key', { apiKey });
      if (apiKey !== null || options.source === 'mutation' || shouldReplayPendingClear) {
        clearPendingManagedKeyCloudClear();
      }
      log.info(
        { hasKey: apiKey !== null, source: options.source, replayedPendingClear: shouldReplayPendingClear },
        'Managed OpenRouter key relayed to cloud',
      );
    } catch (err) {
      if (options.source === 'mutation' && apiKey === null) {
        markPendingManagedKeyCloudClear('mutation_post_failed');
      }
      log.warn({ err }, 'Managed key relay to cloud failed (non-fatal — desktop key still valid)');
    }
  }

  /**
   * Re-push the CURRENT desktop managed (Mindstone subscription) OpenRouter key
   * to cloud with `source: 'sync'`.
   *
   * Used by the initial-connect follow-on and `syncNow()` so that an
   * already-provisioned desktop key (the common case — the user provisioned the
   * managed subscription before pairing cloud) materializes on cloud without
   * waiting for an incidental WS reconnect or the next save/clear mutation.
   * Mirrors the codex `pushCodexTokens(loadCodexTokens(), { source: 'sync' })`
   * precedent.
   *
   * Sync semantics: a transient read-null does NOT clear (the destructive-null
   * guard inside `pushManagedOpenRouterKey` holds), while a durable pending-clear
   * marker still replays the revoke. Never logs the key.
   */
  async pushCurrentManagedKey(): Promise<void> {
    const { loadManagedOpenRouterKey } = await import('@main/services/openRouterTokenStorage');
    await this.pushManagedOpenRouterKey(loadManagedOpenRouterKey(), { source: 'sync' });
  }

  /**
   * Forward a channel via HTTP using the endpoint mapping.
   */
  private async forwardHttp(
    client: CloudServiceClientType,
    channel: string,
    args: unknown[],
  ): Promise<unknown> {
    const endpointDef = CHANNEL_TO_ENDPOINT[channel];

    if (!endpointDef) {
      // Channel is in CLOUD_ROUTABLE_CHANNELS but not mapped — use generic endpoint
      return client.post(`/api/ipc/${encodeURIComponent(channel)}`, { params: args });
    }

    const endpoint = typeof endpointDef === 'function' ? endpointDef(args) : endpointDef;
    const body = endpoint.bodyArgIndex !== undefined ? args[endpoint.bodyArgIndex] : undefined;

    switch (endpoint.method) {
      case 'GET': return client.get(endpoint.path);
      case 'POST': return client.post(endpoint.path, body);
      case 'PUT': return client.put(endpoint.path, body);
      case 'PATCH': return client.patch(endpoint.path, body);
      case 'DELETE': return client.delete(endpoint.path);
    }
  }

  // --- Auto-recovery trigger ------------------------------------------------

  private autoRecoveryInProgress = false;

  /**
   * Check if the circuit breaker has been degraded long enough to trigger
   * automatic machine recovery. Called after recording a failure in the
   * forward path. Fire-and-forget: logs and broadcasts result but never
   * throws into the caller.
   *
   * Requires: Fly-backed instance with stored API token.
   * Guard: only triggers once per degraded period (circuit breaker tracks).
   */
  private checkAutoRecovery(): void {
    const DEGRADED_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
    if (!cloudFailureCooldown.shouldTriggerRecovery(DEGRADED_THRESHOLD_MS)) return;

    if (this.autoRecoveryInProgress) return;

    const settings = this.config?.getSettings();
    const ci = settings?.cloudInstance;
    if (!ci?.flyAppName || !ci?.flyMachineId) return;

    const flyDevMatch = ci.cloudUrl?.match(/^https:\/\/[a-z0-9-]+\.fly\.dev\/?$/i);
    if (!flyDevMatch) return;

    this.autoRecoveryInProgress = true;
    log.warn({ flyAppName: ci.flyAppName, machineId: ci.flyMachineId }, 'Auto-recovery triggered: cloud degraded > 5 minutes');

    this.executeAutoRecoveryCheck(ci.flyAppName, ci.flyMachineId)
      .catch((err) => log.error({ err }, 'Auto-recovery check failed unexpectedly'))
      .finally(() => { this.autoRecoveryInProgress = false; });
  }

  private async executeAutoRecoveryCheck(flyAppName: string, flyMachineId: string): Promise<void> {
    const { loadFlyApiToken } = await import('../flyTokenStorage');
    const token = loadFlyApiToken();

    const broadcastHealth = async (payload: Record<string, unknown>) => {
      try {
        const { getBroadcastService } = await import('@core/broadcastService');
        getBroadcastService().sendToAllWindows('cloud:machine-health', payload);
      } catch { /* renderer may not be ready */ }
    };

    if (!token) {
      log.info('Auto-recovery skipped: no Fly API token stored');
      await broadcastHealth({ status: 'stuck', canAutoRecover: false });
      return;
    }

    const { getMachineState } = await import('@core/services/flyApiClient');
    const result = await getMachineState(token, flyAppName, flyMachineId);

    if (!result.success || !result.machine) {
      log.warn({ error: result.error }, 'Auto-recovery: failed to check machine state');
      await broadcastHealth({ status: 'unknown', canAutoRecover: false });
      return;
    }

    const { state } = result.machine;
    if (state === 'started') {
      log.info('Auto-recovery: machine is actually started, likely a network issue not a stuck machine');
      return;
    }

    const status = state === 'starting' ? 'stuck' : state === 'stopped' ? 'sleeping' : 'unhealthy';

    // For stuck machines (starting > 5min), attempt automatic repair
    if (status === 'stuck') {
      log.warn({ machineState: state }, 'Auto-recovery: machine stuck, invoking repair');
      await broadcastHealth({ status, machineState: state, canAutoRecover: true, repairing: true });

      try {
        const { getHandlerRegistry } = await import('@core/handlerRegistry');
        const handler = getHandlerRegistry().get('cloud:repair-machine');
        if (!handler) {
          log.warn('Auto-recovery: cloud:repair-machine handler not registered');
          await broadcastHealth({ status: 'stuck', machineState: state, canAutoRecover: false });
          return;
        }
        const repairResult = await handler(null) as { success: boolean; error?: string };
        if (repairResult.success) {
          log.info('Auto-recovery: machine repair succeeded');
        } else {
          log.warn({ error: repairResult.error }, 'Auto-recovery: machine repair failed');
          await broadcastHealth({ status: 'stuck', machineState: state, canAutoRecover: true, repairFailed: true, error: repairResult.error });
        }
      } catch (err) {
        log.warn({ err }, 'Auto-recovery: repair invocation failed');
        await broadcastHealth({ status: 'stuck', machineState: state, canAutoRecover: true, repairFailed: true });
      }
      return;
    }

    // For other non-started states, just broadcast for UI
    log.warn({ machineState: state, status }, 'Auto-recovery: machine not started, broadcasting for UI');
    await broadcastHealth({ status, machineState: state, canAutoRecover: status !== 'sleeping' });
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/**
 * Singleton cloud router instance.
 * Imported by registerHandler() to check cloud routing on every IPC call.
 */
export const cloudRouter = new CloudRouter();

// Export the class and internal helpers for testing
export { CloudRouter, mergeSessionTurns as _mergeSessionTurnsForTesting, hasLocalOnlyTurns as _hasLocalOnlyTurnsForTesting, localHasContentCloudLacks as _localHasContentCloudLacksForTesting };
