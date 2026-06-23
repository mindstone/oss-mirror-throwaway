/**
 * Cloud Continuity Metadata
 *
 * Tracks per-session continuity state and lifecycle metadata.
 * Stored in `sessions/cloud-continuity-meta.json`, separate from
 * `cloud-sync-meta.json` to avoid format migration.
 *
 * ## Format
 *
 * Each entry is a `ContinuityMetaEntry`:
 *   { state: 'local_only' | 'cloud_active', lastCloudActivityAt?: number, cloudPinnedAt?: number }
 *
 * Stage 1.2 adds a top-level tombstone sync cursor in the same file:
 *   { sessions: { ...entryMap }, lastSessionTombstoneSyncAt?: number | null }
 * Legacy flat maps are still accepted on read.
 *
 * Backward-compat migration (Stage 5):
 * - Old format (Stage 2–4): `{ "session-id": "cloud_active" }` (plain strings)
 * - New format (Stage 5+):  `{ "session-id": { "state": "cloud_active", ... } }`
 * On load, plain strings are migrated to `{ state: string }`.
 * Objects missing a valid `state` field are skipped.
 *
 * Default: sessions without an explicit entry are `local_only`. Only sessions
 * the user explicitly toggles to cloud (via "Keep in cloud") are `cloud_active`.
 *
 * ## Lifecycle
 *
 * - `lastCloudActivityAt`: updated whenever a session is synced to/from cloud.
 *   Sessions with `lastCloudActivityAt === undefined` are treated as NOT stale
 *   (protects migrated sessions from mass demotion).
 * - `cloudPinnedAt`: set when the user pins a session. Pinned sessions are
 *   exempt from auto-demotion.
 * - Auto-demotion: `cloud_active` sessions inactive for 14 days (and not pinned)
 *   are demoted to `local_only` and a DELETE is enqueued via cloudOutbox.
 *
 * Relationship to cloudSyncMetadata.ts:
 * - cloudSyncMetadata: tracks WHEN a session was last synced (cloudSyncedAt)
 * - cloudContinuityMetadata: tracks WHETHER a session should be replicated (continuityState)
 * Changes to continuityState are written here and are authoritative.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fnvHashBase36 as hashForBreadcrumb } from '@rebel/shared';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import type { CloudRemovalIntent } from '@core/services/continuity/continuityStateTypes';
import { toDiagnosticContinuityTransition } from '@shared/diagnostics/continuityTransition';
import { getDataPath } from '../../utils/dataPaths';
import { getIncrementalSessionStore } from '../incrementalSessionStore';


const log = createScopedLogger({ service: 'cloudContinuityMetadata' });

export type ContinuityState = 'local_only' | 'cloud_active';

export interface ContinuityMetaEntry {
  state: ContinuityState;
  /** Timestamp of last cloud activity (sync, turn, etc.). undefined = never tracked (not stale). */
  lastCloudActivityAt?: number;
  /** Timestamp when the user pinned this session to cloud. undefined = not pinned. */
  cloudPinnedAt?: number;
  /** Optional explicit removal intent propagated to the cloud continuity state map. */
  cloudRemovalIntent?: CloudRemovalIntent;
}

const SESSIONS_DIR = 'sessions';
const META_FILENAME = 'cloud-continuity-meta.json';
const DEV_ASSERTIONS_ENABLED = process.env.NODE_ENV !== 'production';

type TransitionReason = 'cloud-enabled' | 'cloud-disabled' | 'first-cloud-sync' | 'manual-reset';
export type LocalOnlyIntent = 'user' | 'retention-policy' | 'inferred';

/**
 * Map a desktop-side LocalOnlyIntent to the durable CloudRemovalIntent that crosses the wire to cloud.
 * `'inferred'` is the no-evidence fallback used when classification could not establish user vs lifecycle
 * intent — it MUST NOT cross the wire, otherwise the cloud's merge guard would treat heuristic guesses
 * as authoritative removal requests. The cloud's GC user-intent gate relies on `requestedBy === 'user'`,
 * so this typed helper is the single point that enforces the invariant for all callers.
 */
export function localOnlyIntentToWire(
  intent: LocalOnlyIntent,
  requestedAt: number = Date.now(),
): CloudRemovalIntent | undefined {
  if (intent === 'inferred') {
    return undefined;
  }
  return {
    requestedAt,
    requestedBy: intent,
    source: 'desktop',
  };
}

export interface FlushContinuityMetadataResult {
  success: boolean;
  error?: Error;
}

type TurnPersistenceAckStatus = 'in_flight' | 'persisted' | 'errored';

/** In-memory map: sessionId -> ContinuityMetaEntry */
let continuityMeta: Map<string, ContinuityMetaEntry> = new Map();
/** Cursor for incremental session tombstone syncs on desktop. */
let lastSessionTombstoneSyncAt: number | null = null;
/** In-memory turn ack tracker keyed by sessionId+turnId (never persisted). */
let turnPersistenceAckBySession: Map<string, Map<string, TurnPersistenceAckStatus>> = new Map();

/** Whether metadata has been loaded from disk */
let loaded = false;

/** Debounce timer for writes */
let writeTimer: ReturnType<typeof setTimeout> | null = null;
const WRITE_DEBOUNCE_MS = 1_000;

function recordStateTransitionBreadcrumb(args: {
  sessionId: string;
  from: ContinuityState;
  to: ContinuityState;
  reason: TransitionReason;
}): void {
  const data = {
    sessionIdHash: hashForBreadcrumb(args.sessionId),
    from: args.from,
    to: args.to,
    reason: args.reason,
  };
  getErrorReporter().addBreadcrumb({
    category: 'continuity.continuity-state',
    message: 'state-transition',
    data,
  });
  appendDiagnosticEvent(toDiagnosticContinuityTransition({
    family: 'metadata',
    category: 'continuity.continuity-state',
    message: 'state-transition',
    data,
  }));
}

function recordInvariantViolation(args: { sessionId: string; invariant: string }): void {
  const data = {
    sessionIdHash: hashForBreadcrumb(args.sessionId),
    invariant: args.invariant,
  };
  getErrorReporter().addBreadcrumb({
    category: 'continuity.continuity-state',
    level: 'error',
    message: 'invariant-violation',
    data,
  });
  appendDiagnosticEvent(toDiagnosticContinuityTransition({
    family: 'metadata',
    category: 'continuity.continuity-state',
    level: 'error',
    message: 'invariant-violation',
    data,
  }));

  if (DEV_ASSERTIONS_ENABLED) {
    console.error(`[continuity invariant] ${args.invariant} (${args.sessionId})`);
  }
}

function hasUnackedPersistedTurn(session: {
  id: string;
  activeTurnId?: string | null;
}): boolean {
  const activeTurnId = typeof session.activeTurnId === 'string' ? session.activeTurnId.trim() : '';
  if (activeTurnId.length === 0) return false;
  return getTurnPersistenceAckStatus(session.id, activeTurnId) !== 'persisted';
}

function validateTransitionInvariants(sessionId: string, targetState: ContinuityState): void {
  void Promise.resolve(getIncrementalSessionStore().getSession(sessionId))
    .then((session) => {
      if (!session) return;

      if (targetState === 'cloud_active') {
        if (hasUnackedPersistedTurn(session)) {
          recordInvariantViolation({
            sessionId,
            invariant: 'cloud-active-requires-acked-turn-id',
          });
        }
        return;
      }

      if ((session.cloudUpdatedAt ?? 0) > 0) {
        recordInvariantViolation({
          sessionId,
          invariant: 'local-only-has-cloud-updated-at',
        });
      }
    })
    .catch((err) => {
      log.debug({ err }, 'Failed to evaluate continuity invariants');
    });
}

function getMetaFilePath(): string {
  return path.join(getDataPath(), SESSIONS_DIR, META_FILENAME);
}

/**
 * Validate that a parsed value is a valid ContinuityMetaEntry.
 * Accepts both old string format (migrates) and new object format.
 */
function isValidState(value: unknown): value is ContinuityState {
  return value === 'local_only' || value === 'cloud_active';
}

function isValidMetaEntry(value: unknown): value is ContinuityMetaEntry {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return isValidState(obj.state);
}

function sanitizeCloudRemovalIntent(value: unknown): CloudRemovalIntent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.requestedAt !== 'number'
    || !Number.isFinite(record.requestedAt)
    || record.requestedAt <= 0
  ) {
    return undefined;
  }
  if (record.requestedBy !== 'user' && record.requestedBy !== 'retention-policy') {
    return undefined;
  }
  const intent: CloudRemovalIntent = {
    requestedAt: record.requestedAt,
    requestedBy: record.requestedBy,
  };
  if (
    record.source === 'desktop'
    || record.source === 'mobile'
    || record.source === 'web'
    || record.source === 'cloud'
  ) {
    intent.source = record.source;
  }
  return intent;
}

/**
 * Parse and migrate a raw on-disk value to a ContinuityMetaEntry.
 * Returns null if the value is invalid.
 */
function parseEntry(value: unknown): ContinuityMetaEntry | null {
  // Old format: plain string ("cloud_active" | "local_only")
  if (typeof value === 'string') {
    if (isValidState(value)) {
      return { state: value };
    }
    return null;
  }
  // New format: object with state field
  if (isValidMetaEntry(value)) {
    const record = value as unknown as Record<string, unknown>;
    const entry: ContinuityMetaEntry = {
      state: record.state as ContinuityState,
    };
    if (typeof record.lastCloudActivityAt === 'number' && Number.isFinite(record.lastCloudActivityAt)) {
      entry.lastCloudActivityAt = record.lastCloudActivityAt;
    }
    if (typeof record.cloudPinnedAt === 'number' && Number.isFinite(record.cloudPinnedAt)) {
      // Invariant: local_only sessions cannot be pinned. Drop the stale pin on read so a
      // corrupted file (e.g. mid-write crash, manual edit, downgrade-then-upgrade) can't
      // resurrect a removed session by tricking the merge guards.
      if (entry.state === 'local_only') {
        log.warn(
          { cloudPinnedAt: record.cloudPinnedAt },
          'Dropping invariant-violating cloudPinnedAt on local_only entry during load',
        );
      } else {
        entry.cloudPinnedAt = record.cloudPinnedAt;
      }
    }
    const cloudRemovalIntent = sanitizeCloudRemovalIntent(record.cloudRemovalIntent);
    if (entry.state !== 'cloud_active' && cloudRemovalIntent) {
      entry.cloudRemovalIntent = cloudRemovalIntent;
    }
    return entry;
  }
  return null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Schema version for cloud-continuity-meta.json. Bump when the on-disk shape changes
 * in a way that needs explicit migration logic. Missing version on load is treated as v1
 * (legacy files written before this stamp existed). Unknown future versions log a warning
 * and parse on best-effort basis — they were written by a newer build, so we should be
 * resilient to forward compatibility rather than blow away the file.
 */
const META_SCHEMA_VERSION = 1;

function parseFileShape(raw: unknown): { entries: Record<string, unknown>; lastTombstoneSyncAt: number | null } {
  if (!isObjectRecord(raw)) {
    return { entries: {}, lastTombstoneSyncAt: null };
  }

  // New shape (Stage 1.2+): { sessions: {...}, lastSessionTombstoneSyncAt, schemaVersion? }
  const sessions = raw.sessions;
  if (isObjectRecord(sessions)) {
    if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > META_SCHEMA_VERSION) {
      log.warn(
        { onDisk: raw.schemaVersion, supported: META_SCHEMA_VERSION },
        'cloud-continuity-meta.json was written by a newer build; parsing on best-effort basis',
      );
    }
    const cursor = typeof raw.lastSessionTombstoneSyncAt === 'number' && Number.isFinite(raw.lastSessionTombstoneSyncAt)
      ? raw.lastSessionTombstoneSyncAt
      : null;
    return { entries: sessions, lastTombstoneSyncAt: cursor };
  }

  // Legacy shape: flat entry map
  return { entries: raw, lastTombstoneSyncAt: null };
}

/**
 * Load continuity metadata from disk. Safe to call multiple times (no-op after first load).
 * Handles backward-compat migration from flat string format to object format.
 */
export function loadContinuityMetadata(): void {
  if (loaded) return;
  try {
    const filePath = getMetaFilePath();
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const { entries, lastTombstoneSyncAt } = parseFileShape(parsed);
      continuityMeta = new Map();
      lastSessionTombstoneSyncAt = lastTombstoneSyncAt;
      let migrated = 0;
      let skipped = 0;
      for (const [key, value] of Object.entries(entries)) {
        const entry = parseEntry(value);
        if (entry) {
          continuityMeta.set(key, entry);
          // Count old-format entries that were migrated
          if (typeof value === 'string') migrated++;
        } else {
          skipped++;
        }
      }
      log.info(
        { count: continuityMeta.size, migrated, skipped, lastSessionTombstoneSyncAt },
        'Loaded cloud continuity metadata',
      );
    }
  } catch (err) {
    log.warn({ err }, 'Failed to load cloud continuity metadata, starting fresh');
    continuityMeta = new Map();
    lastSessionTombstoneSyncAt = null;
  }
  loaded = true;
}

/**
 * Write metadata to disk (debounced).
 */
function scheduleDiskWrite(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writeToDisk();
  }, WRITE_DEBOUNCE_MS);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function writeToDisk(): FlushContinuityMetadataResult {
  try {
    const filePath = getMetaFilePath();
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const data = {
      schemaVersion: META_SCHEMA_VERSION,
      sessions: Object.fromEntries(continuityMeta),
      lastSessionTombstoneSyncAt,
    };
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
    return { success: true };
  } catch (err) {
    const error = normalizeError(err);
    log.warn({ err: error }, 'Failed to write cloud continuity metadata');
    return { success: false, error };
  }
}

/**
 * Get the continuityState for a session.
 *
 * Returns the explicitly stored state, or `local_only` if not set.
 * Sessions are local_only by default — only sessions explicitly toggled
 * to cloud via the UI should be cloud_active.
 */
export function getContinuityState(sessionId: string): ContinuityState {
  loadContinuityMetadata();
  const entry = continuityMeta.get(sessionId);
  if (entry !== undefined) return entry.state;
  return 'local_only';
}

/**
 * Get the full metadata entry for a session (or null if not explicitly set).
 */
export function getContinuityEntry(sessionId: string): ContinuityMetaEntry | null {
  loadContinuityMetadata();
  return continuityMeta.get(sessionId) ?? null;
}

export function getTurnPersistenceAckStatus(
  sessionId: string,
  turnId: string,
): TurnPersistenceAckStatus | null {
  const normalizedSessionId = sessionId.trim();
  const normalizedTurnId = turnId.trim();
  if (!normalizedSessionId || !normalizedTurnId) return null;
  return turnPersistenceAckBySession.get(normalizedSessionId)?.get(normalizedTurnId) ?? null;
}

export function recordTurnPersistenceAckStatus(
  sessionId: string,
  turnId: string,
  status: TurnPersistenceAckStatus,
): void {
  const normalizedSessionId = sessionId.trim();
  const normalizedTurnId = turnId.trim();
  if (!normalizedSessionId || !normalizedTurnId) return;
  const byTurnId = turnPersistenceAckBySession.get(normalizedSessionId) ?? new Map<string, TurnPersistenceAckStatus>();
  byTurnId.set(normalizedTurnId, status);
  turnPersistenceAckBySession.set(normalizedSessionId, byTurnId);
}

/**
 * Check whether a session is marked cloud_active.
 */
export function isCloudActive(sessionId: string): boolean {
  return getContinuityState(sessionId) === 'cloud_active';
}

/**
 * Mark a session as cloud_active (will be included in cloud replication).
 * Called when a session is synced to/from cloud.
 */
export function markCloudActive(sessionId: string, reason: TransitionReason = 'cloud-enabled'): void {
  loadContinuityMetadata();
  const existing = continuityMeta.get(sessionId);
  const from = existing?.state ?? 'local_only';
  if (from === 'cloud_active' && !existing?.cloudRemovalIntent) return; // already set, skip write

  if (existing?.cloudRemovalIntent) {
    const sessionIdHash = hashForBreadcrumb(sessionId);
    const previousIntent = {
      requestedBy: existing.cloudRemovalIntent.requestedBy,
      requestedAt: existing.cloudRemovalIntent.requestedAt,
    };
    log.info(
      {
        sessionIdHash,
        previousIntent,
        reason: 'cloud-active-promotion',
      },
      'Cleared cloud removal intent during cloud-active promotion',
    );
    getErrorReporter().addBreadcrumb({
      category: 'continuity.intent-cleared',
      message: 'cloud-removal-intent-cleared',
      data: {
        sessionIdHash,
        previousIntent,
        reason: 'cloud-active-promotion',
      },
    });
    appendDiagnosticEvent(toDiagnosticContinuityTransition({
      family: 'metadata',
      category: 'continuity.intent-cleared',
      message: 'cloud-removal-intent-cleared',
      data: {
        sessionIdHash,
        reason: 'cloud-active-promotion',
      },
    }));
  }

  const transitionReason: TransitionReason = existing ? reason : 'first-cloud-sync';
  continuityMeta.set(sessionId, {
    ...existing,
    state: 'cloud_active',
    cloudRemovalIntent: undefined,
  });
  if (from !== 'cloud_active') {
    recordStateTransitionBreadcrumb({
      sessionId,
      from,
      to: 'cloud_active',
      reason: transitionReason,
    });
  }
  validateTransitionInvariants(sessionId, 'cloud_active');
  scheduleDiskWrite();
}

/**
 * Mark a session as local_only (excluded from cloud replication).
 * Used for sessions the user wants to keep desktop-only.
 * Clears the pin if set (local_only sessions can't be pinned).
 */
export function markLocalOnly(
  sessionId: string,
  reason: TransitionReason,
  intent: LocalOnlyIntent,
): void {
  loadContinuityMetadata();
  const existing = continuityMeta.get(sessionId);
  const from = existing?.state ?? 'local_only';
  const cloudRemovalIntent = localOnlyIntentToWire(intent);
  if (existing?.state === 'local_only' && !existing.cloudPinnedAt && !existing.cloudRemovalIntent && !cloudRemovalIntent) {
    return;
  }
  continuityMeta.set(sessionId, {
    state: 'local_only',
    lastCloudActivityAt: existing?.lastCloudActivityAt,
    // Clear pin on demotion — local_only sessions can't be pinned
    cloudPinnedAt: undefined,
    cloudRemovalIntent,
  });
  if (from !== 'local_only') {
    recordStateTransitionBreadcrumb({
      sessionId,
      from,
      to: 'local_only',
      reason,
    });
  }
  validateTransitionInvariants(sessionId, 'local_only');
  scheduleDiskWrite();
}

/**
 * Set continuity state explicitly.
 */
export function setContinuityState(sessionId: string, state: ContinuityState): void {
  if (state === 'cloud_active') {
    markCloudActive(sessionId, 'manual-reset');
  } else {
    markLocalOnly(sessionId, 'manual-reset', 'user');
  }
}

/**
 * Update the lastCloudActivityAt timestamp for a session.
 * Called on cloud sync, agent turn, or session access from cloud.
 */
export function touchCloudActivity(sessionId: string): void {
  loadContinuityMetadata();
  const existing = continuityMeta.get(sessionId);
  if (!existing) return; // No entry — don't create one just for activity tracking
  existing.lastCloudActivityAt = Date.now();
  scheduleDiskWrite();
}

/**
 * Pin a session to cloud (prevents auto-demotion).
 * If the session is currently local_only, auto-promotes to cloud_active.
 */
export function pinToCloud(sessionId: string): void {
  loadContinuityMetadata();
  const existing = continuityMeta.get(sessionId);
  const state = existing?.state ?? getContinuityState(sessionId);
  continuityMeta.set(sessionId, {
    ...existing,
    state: state === 'local_only' ? 'cloud_active' : state,
    cloudPinnedAt: Date.now(),
    cloudRemovalIntent: undefined,
  });
  scheduleDiskWrite();
}

/**
 * Unpin a session from cloud (re-subjects to auto-demotion rules).
 */
export function unpinFromCloud(sessionId: string): void {
  loadContinuityMetadata();
  const existing = continuityMeta.get(sessionId);
  if (!existing || !existing.cloudPinnedAt) return; // Not pinned
  existing.cloudPinnedAt = undefined;
  scheduleDiskWrite();
}

/**
 * Get all cloud_active sessions that have been inactive for longer than
 * `maxInactivityMs` and are not pinned.
 *
 * Sessions with `lastCloudActivityAt === undefined` are treated as NOT stale.
 * This protects migrated sessions (from old format) from mass demotion.
 */
export function getStaleCloudSessions(maxInactivityMs: number): string[] {
  loadContinuityMetadata();
  const threshold = Date.now() - maxInactivityMs;
  const stale: string[] = [];
  for (const [sessionId, entry] of continuityMeta) {
    if (entry.state !== 'cloud_active') continue;
    if (entry.cloudPinnedAt) continue; // Pinned — exempt
    if (entry.lastCloudActivityAt === undefined) continue; // No activity tracked — not stale
    if (entry.lastCloudActivityAt < threshold) {
      stale.push(sessionId);
    }
  }
  return stale;
}

/**
 * Get all continuity states as a plain record (for IPC/renderer).
 */
export function getAllContinuityStates(): Record<string, {
  state: ContinuityState;
  lastCloudActivityAt?: number;
  cloudPinnedAt?: number;
  cloudRemovalIntent?: CloudRemovalIntent;
}> {
  loadContinuityMetadata();
  const result: Record<string, {
    state: ContinuityState;
    lastCloudActivityAt?: number;
    cloudPinnedAt?: number;
    cloudRemovalIntent?: CloudRemovalIntent;
  }> = {};
  for (const [sessionId, entry] of continuityMeta) {
    result[sessionId] = { ...entry };
  }
  return result;
}

export function getLastSessionTombstoneSyncAt(): number | null {
  loadContinuityMetadata();
  return lastSessionTombstoneSyncAt;
}

export function setLastSessionTombstoneSyncAt(timestamp: number): void {
  if (!Number.isFinite(timestamp)) return;
  loadContinuityMetadata();
  if (lastSessionTombstoneSyncAt !== null && timestamp <= lastSessionTombstoneSyncAt) return;
  lastSessionTombstoneSyncAt = timestamp;
  scheduleDiskWrite();
}

/**
 * Remove continuity metadata for a session (e.g., when session is deleted).
 */
export function removeContinuityMetadata(sessionId: string): void {
  loadContinuityMetadata();
  turnPersistenceAckBySession.delete(sessionId);
  if (continuityMeta.delete(sessionId)) {
    scheduleDiskWrite();
  }
}

export function restoreContinuityEntrySnapshot(sessionId: string, snapshot: ContinuityMetaEntry | null): void {
  loadContinuityMetadata();
  if (snapshot) {
    continuityMeta.set(sessionId, {
      ...snapshot,
      ...(snapshot.cloudRemovalIntent ? { cloudRemovalIntent: { ...snapshot.cloudRemovalIntent } } : { cloudRemovalIntent: undefined }),
    });
  } else {
    continuityMeta.delete(sessionId);
  }
  scheduleDiskWrite();
}

/**
 * Flush pending writes immediately (for shutdown or tests).
 *
 * Most callers intentionally fire-and-forget and rely on the debounced retry
 * path. Only `syncSessionFromCloud` checks this result for race-fix
 * observability/rollback breadcrumbs.
 */
export async function flushContinuityMetadata(): Promise<FlushContinuityMetadataResult> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (!loaded) return { success: true };
  return writeToDisk();
}

/**
 * Reset in-memory state (for tests only).
 */
export function _resetForTesting(): void {
  continuityMeta = new Map();
  lastSessionTombstoneSyncAt = null;
  turnPersistenceAckBySession = new Map();
  loaded = false;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}
