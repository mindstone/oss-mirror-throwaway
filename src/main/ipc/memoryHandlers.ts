/**
 * Memory Domain IPC Handlers
 *
 * Handles memory history operations for the "What Rebel Knows" panel.
 */

import path from 'node:path';
import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import type { MemoryUpdateStatus, TimeSavedStatus } from '@shared/types';
import { getBroadcastService } from '@core/broadcastService';
import { broadcastTypedPayload } from '@shared/ipc/broadcasts';
import { resolveFileLocation, FileLocationResolverError } from '@core/services/fileLocation';
import type { SpaceInfo as ResolverSpaceInfo } from '@shared/ipc/schemas/library';
import { FileLocationSchema, type BlockSource, type FileLocation } from '@rebel/shared';
import {
  getMemoryHistory,
  getMemoryHistoryCount,
  getMemoryStats,
  getMemoryHistoryEntry,
  removeMemoryHistoryEntry,
  repairStaleFilePathsIfNeeded,
  repairMemoryHistoryEntryPath,
} from '../services/memoryHistoryStore';
import { getPendingMemoryApprovals, handleMemoryWriteApprovalResponse, removePendingMemoryApproval } from '../services/safety';
import { scanSpaces } from '../services/spaceService';
import {
  listPendingFiles,
  getPendingFile,
  getPendingContent,
  publishPendingFile,
  deletePendingFile,
  keepPendingFilePrivate,
  publishWithConflictResolution as publishPendingWithConflict,
  detectPendingConflict,
  canonicalizePath,
  type PendingFile,
  type PublishResult,
} from '../services/safety/cosPendingService';
import { emitDeferredTranscriptSaved, emitTranscriptSavedFromMeta, removeDeferredTranscriptSaved } from '../services/meetingBot/transcriptEventBus';
import { getSettings } from '../settingsStore';
import { registerHandler } from './utils/registerHandler';
import { isNonEmptyString } from '@shared/utils/validators';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { getIncrementalSessionStore } from '../services/incrementalSessionStore';
import { resolveItem } from '../services/safety/automationPendingItemsTracker';
import { getAutomationContext } from '../services/safety/automationContextLookup';
import { sharedSkillMutationService } from '../services/sharedSkillMutationService';
import { getCurrentUserProvider } from '@core/currentUserProvider';
import { updateSessionWithReload } from '@core/services/lockedSessionPersistence';
import type { OwnerKind } from '@core/services/superMcpOwnerRegistry';
import type { SessionLockManager } from '@core/utils/sessionFileLock';
import type { ConflictCapabilityService } from '@core/services/safety/conflictCapabilityService';
import type { IpcDedupService } from '@core/services/safety/ipcDedupService';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';
import { nextContentUpdatedAt } from '@shared/utils/sessionTimestamps';
import { classifySessionKind } from '@shared/sessionKind';

/** Broadcast memory approval resolved event to all renderer windows for real-time sync */
function broadcastMemoryApprovalResolved(toolUseId: string, originalSessionId: string, approved: boolean): void {
  broadcastTypedPayload(getBroadcastService(), 'memory:write-approval-resolved', { toolUseId, originalSessionId, approved });
}

const log = createScopedLogger({ service: 'memoryHandlers' });

function isAutomationFamilySession(sessionId: string | undefined): sessionId is string {
  if (!sessionId) return false;
  const kind = classifySessionKind(sessionId);
  return kind === 'automation' || kind === 'automation-insight';
}

/**
 * Dedup file-location warnings for the lifetime of this process.
 * Stage 2b keeps this in-perpetuity; invalidation can be wired later.
 */
const fileLocationWarned = new Map<string, boolean>();

function warnFileLocationFallbackOnce(params: {
  pendingDestination: string;
  originalSpace: string | undefined;
  coreDirectory: string | undefined;
  handler: 'memory:staging-get-all' | 'memory:get-pending-approvals';
}): void {
  const key = `fallback:${params.pendingDestination}`;
  if (fileLocationWarned.get(key)) {
    return;
  }
  fileLocationWarned.set(key, true);
  log.warn(
    {
      pendingDestination: params.pendingDestination,
      originalSpace: params.originalSpace,
      coreDirectory: params.coreDirectory,
      handler: params.handler,
    },
    'FileLocation fell back to outside-workspace',
  );
}

function warnInvalidStoredLocationOnce(params: {
  filePath: string;
  coreDirectory: string | undefined;
}): void {
  const key = `invalid-stored:${params.filePath}`;
  if (fileLocationWarned.get(key)) {
    return;
  }
  fileLocationWarned.set(key, true);
  log.warn(
    {
      filePath: params.filePath,
      coreDirectory: params.coreDirectory,
      handler: 'memory:get-pending-approvals',
    },
    'Pending memory approval had invalid persisted FileLocation; reprojecting from filePath',
  );
}

/**
 * Phase-7 hardening: when the live resolver throws but we have a valid
 * persisted `storedLocation`, we reuse that stale projection instead of
 * dropping the row. This keeps the approval user-visible but the staleness
 * is a real observability concern — add a warn-dedup'd breadcrumb so the
 * silent fallback surfaces in logs. Per AGENTS.md § "Silent failure is a bug".
 */
function warnResolverFailedStoredReuseOnce(params: {
  filePath: string;
  coreDirectory: string | undefined;
  errorMessage: string;
}): void {
  const key = `resolver-failed-stored-reuse:${params.filePath}`;
  if (fileLocationWarned.get(key)) {
    return;
  }
  fileLocationWarned.set(key, true);
  log.warn(
    {
      filePath: params.filePath,
      coreDirectory: params.coreDirectory,
      errorMessage: params.errorMessage,
      handler: 'memory:get-pending-approvals',
    },
    'FileLocation resolver failed; reusing stale persisted location so approval stays visible',
  );
}

function debugStoredLocationMismatchOnce(params: {
  filePath: string;
  storedLocation: FileLocation;
  recomputedLocation: FileLocation;
}): void {
  const key = `projection-mismatch:${params.filePath}`;
  if (fileLocationWarned.get(key)) {
    return;
  }
  fileLocationWarned.set(key, true);
  log.debug(
    {
      filePath: params.filePath,
      storedLocation: params.storedLocation,
      recomputedLocation: params.recomputedLocation,
      handler: 'memory:get-pending-approvals',
    },
    'Pending memory approval stored FileLocation disagreed with recomputed projection; using recomputed value',
  );
}

function fileLocationsMatch(left: FileLocation, right: FileLocation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * After a staged transcript file is published, attempt to emit the deferred
 * transcript-saved event so the transcript-analysis automation can fire.
 */
function tryEmitDeferredTranscriptEvent(
  pendingDestination: string,
  pendingTranscriptMeta: string | undefined,
  coreDirectory: string,
): void {
  const absoluteDest = path.isAbsolute(pendingDestination)
    ? pendingDestination
    : path.join(coreDirectory, pendingDestination);
  const canonical = canonicalizePath(absoluteDest);

  // Try in-memory deferred event first (common case: approve in same session)
  if (emitDeferredTranscriptSaved(canonical, absoluteDest)) return;

  // Fallback: reconstruct event from frontmatter metadata (app restarted between stage and approve)
  if (pendingTranscriptMeta) {
    emitTranscriptSavedFromMeta(absoluteDest, pendingTranscriptMeta);
  }
}

/**
 * Clean up deferred transcript event when a staged file is discarded or kept private.
 */
function cleanupDeferredTranscriptEvent(
  pendingDestination: string,
  coreDirectory: string,
): void {
  const absoluteDest = path.isAbsolute(pendingDestination)
    ? pendingDestination
    : path.join(coreDirectory, pendingDestination);
  removeDeferredTranscriptSaved(absoluteDest);
}

/**
 * Publish a pending file through managed shared skill write when the file
 * was staged via a shared skill checkpoint. Re-classifies the destination
 * from disk at publish time (security — don't trust frontmatter alone).
 * Falls back to normal `publishPendingFile()` when the destination is no
 * longer a shared skill.
 *
 * Returns null when the file is NOT a shared skill checkpoint (caller
 * should proceed with normal publish).
 */
async function tryPublishAsSharedSkill(pendingFile: PendingFile): Promise<PublishResult | null> {
  if (pendingFile.frontmatter.approval_kind !== 'shared_skill_checkpoint') {
    return null;
  }

  const settings = getSettings();
  const coreDirectory = settings?.coreDirectory;
  if (!coreDirectory) {
    return null; // No workspace — can't re-classify, fall through to normal publish
  }

  const pendingDest = pendingFile.frontmatter.pending_destination;
  const absoluteDest = path.isAbsolute(pendingDest)
    ? pendingDest
    : path.join(coreDirectory, pendingDest);

  // Re-classify destination from disk (FM #22: don't trust frontmatter approvalKind alone)
  const classified = await sharedSkillMutationService.classifySharedSkillPath(absoluteDest, coreDirectory);
  if (!classified) {
    // No longer a shared skill (space removed, sharing changed) — fall back to normal publish
    log.info({ id: pendingFile.id, absoluteDest }, 'Shared skill checkpoint destination no longer classified as shared skill — falling back to normal publish');
    return null;
  }

  // Route through managed write with human actor (the person who approves)
  const actor = { kind: 'human' as const, user: getCurrentUserProvider().getCurrentUser() };
  const context: { baseContentHash?: string } = {};
  if (pendingFile.frontmatter.base_hash && pendingFile.frontmatter.base_hash !== 'new-file') {
    context.baseContentHash = pendingFile.frontmatter.base_hash;
  }

  let writeResult;
  try {
    writeResult = await sharedSkillMutationService.writeManagedSkillFile(
      absoluteDest, pendingFile.content, coreDirectory, actor, context,
    );
  } catch (err) {
    log.error({ err, id: pendingFile.id, absoluteDest }, 'Managed skill write threw during publish');
    return { status: 'error', error: 'Managed skill write failed unexpectedly' };
  }

  if (!writeResult) {
    log.warn({ id: pendingFile.id, absoluteDest }, 'Managed skill write returned null');
    return { status: 'error', error: 'Managed skill write failed — path may no longer be valid' };
  }

  if (writeResult.conflict) {
    log.info({ id: pendingFile.id, absoluteDest, currentHash: writeResult.currentHash }, 'Conflict detected during managed skill publish');
    try {
      const { readFile } = await import('node:fs/promises');
      const currentContent = await readFile(absoluteDest, 'utf-8');
      return {
        status: 'conflict',
        conflict: { currentContent, pendingContent: pendingFile.content },
      };
    } catch {
      return { status: 'error', error: 'Conflict detected but could not read current file' };
    }
  }

  // Write succeeded — delete pending file (staged content is now published)
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(pendingFile.filePath).catch(() => {});
  } catch {
    log.warn({ id: pendingFile.id }, 'Failed to delete pending file after managed skill publish');
  }

  log.info({ id: pendingFile.id, absoluteDest }, 'Published shared skill via managed write');
  return { status: 'success' };
}

/**
 * Clean up stale approval metadata when a staged file is published or discarded.
 * If the pending file has a `tool_use_id`, removes the corresponding persisted
 * approval entry and broadcasts resolution so approval cards are cleared from
 * desktop/cloud/mobile surfaces.
 */
function cleanupStagedApproval(pendingFile: PendingFile, approved: boolean): void {
  const toolUseId = pendingFile.frontmatter.tool_use_id;
  if (!toolUseId) return;

  removePendingMemoryApproval(toolUseId);
  const originalSessionId = pendingFile.frontmatter.session_id ?? '';
  broadcastMemoryApprovalResolved(toolUseId, originalSessionId, approved);
  log.info({ toolUseId, approved }, 'Cleaned up stale approval metadata for staged file');
}

export async function applyMemoryUpdateStatusToSession(params: {
  sessionId: string;
  turnId: string;
  status: MemoryUpdateStatus;
}): Promise<{ ok: boolean; error?: string; context?: Record<string, unknown> }> {
  const { sessionId, turnId, status } = params;
  const validationResult = validateStatusApplyPayload({
    kind: 'memory-update',
    sessionId,
    turnId,
    statusSessionId: status.originalSessionId,
    statusTurnId: status.originalTurnId,
  });
  if (validationResult) {
    return validationResult;
  }

  try {
    const locking = requireSessionLockingDeps();
    const result = await updateSessionWithReload({
      sessionId,
      store: getIncrementalSessionStore(),
      lockManager: locking.lockManager,
      ownerKind: locking.ownerKind,
      update: (session) => {
        if (!session) return null;
        return {
          ...session,
          memoryUpdateStatusByTurn: {
            ...(session.memoryUpdateStatusByTurn ?? {}),
            [turnId]: status,
          },
          updatedAt: nextContentUpdatedAt(session.updatedAt),
        };
      },
    });
    if (!result.updated) {
      return { ok: false, error: 'session-not-found' };
    }
    return { ok: true };
  } catch (err) {
    log.error({ err, sessionId, turnId }, 'Failed to apply memory update status to session');
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function applyTimeSavedStatusToSession(params: {
  sessionId: string;
  turnId: string;
  status: TimeSavedStatus;
}): Promise<{ ok: boolean; error?: string; context?: Record<string, unknown> }> {
  const { sessionId, turnId, status } = params;
  const validationResult = validateStatusApplyPayload({
    kind: 'time-saved',
    sessionId,
    turnId,
    statusSessionId: status.originalSessionId,
    statusTurnId: status.turnId,
  });
  if (validationResult) {
    return validationResult;
  }

  try {
    const locking = requireSessionLockingDeps();
    const result = await updateSessionWithReload({
      sessionId,
      store: getIncrementalSessionStore(),
      lockManager: locking.lockManager,
      ownerKind: locking.ownerKind,
      update: (session) => {
        if (!session) return null;
        return {
          ...session,
          timeSavedStatusByTurn: {
            ...(session.timeSavedStatusByTurn ?? {}),
            [turnId]: status,
          },
          updatedAt: nextContentUpdatedAt(session.updatedAt),
        };
      },
    });
    if (!result.updated) {
      return { ok: false, error: 'session-not-found' };
    }
    return { ok: true };
  } catch (err) {
    log.error({ err, sessionId, turnId }, 'Failed to apply time saved status to session');
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

type StatusApplyKind = 'memory-update' | 'time-saved';
type StatusApplyErrorCode =
  | 'invalid-session-id'
  | 'invalid-turn-id'
  | 'cross-field-mismatch';

type StatusApplyFailure = {
  ok: false;
  error: StatusApplyErrorCode;
  context: Record<string, unknown>;
};

function rejectStatusApplyPayload(params: {
  kind: StatusApplyKind;
  error: StatusApplyErrorCode;
  reason: string;
  sessionId: string;
  turnId: string;
  statusSessionId?: string;
  statusTurnId?: string;
  sessionIdMatches?: boolean;
  turnIdMatches?: boolean;
}): StatusApplyFailure {
  const context: Record<string, unknown> = {
    kind: params.kind,
    reason: params.reason,
    sessionIdHash: hashSessionIdForBreadcrumb(params.sessionId),
    turnIdHash: hashSessionIdForBreadcrumb(params.turnId),
    statusSessionIdHash: hashSessionIdForBreadcrumb(params.statusSessionId ?? ''),
    statusTurnIdHash: hashSessionIdForBreadcrumb(params.statusTurnId ?? ''),
  };
  if (params.sessionIdMatches !== undefined) {
    context.sessionIdMatches = params.sessionIdMatches;
  }
  if (params.turnIdMatches !== undefined) {
    context.turnIdMatches = params.turnIdMatches;
  }

  log.warn(context, 'Rejected malformed status-apply payload');
  getErrorReporter().addBreadcrumb({
    category: 'status-apply-validation-failed',
    message: 'Rejected malformed status-apply payload',
    level: 'warning',
    data: context,
  });

  return {
    ok: false,
    error: params.error,
    context,
  };
}

function validateStatusApplyPayload(params: {
  kind: StatusApplyKind;
  sessionId: string;
  turnId: string;
  statusSessionId?: string;
  statusTurnId?: string;
}): StatusApplyFailure | null {
  const { kind, sessionId, turnId, statusSessionId, statusTurnId } = params;

  if (!isNonEmptyString(sessionId)) {
    return rejectStatusApplyPayload({
      kind,
      error: 'invalid-session-id',
      reason: 'sessionId must be a non-empty string',
      sessionId,
      turnId,
      statusSessionId,
      statusTurnId,
    });
  }

  if (!isNonEmptyString(turnId)) {
    return rejectStatusApplyPayload({
      kind,
      error: 'invalid-turn-id',
      reason: 'turnId must be a non-empty string',
      sessionId,
      turnId,
      statusSessionId,
      statusTurnId,
    });
  }

  const sessionIdMatches = isNonEmptyString(statusSessionId) && statusSessionId === sessionId;
  const turnIdMatches = isNonEmptyString(statusTurnId) && statusTurnId === turnId;
  if (!sessionIdMatches || !turnIdMatches) {
    return rejectStatusApplyPayload({
      kind,
      error: 'cross-field-mismatch',
      reason: 'status payload turn/session provenance does not match request envelope',
      sessionId,
      turnId,
      statusSessionId,
      statusTurnId,
      sessionIdMatches,
      turnIdMatches,
    });
  }

  return null;
}

export interface MemoryHandlerDeps {
  triggerForgetMemory?: (entryId: string) => Promise<{ success: boolean; error?: string }>;
  getWorkspacePath?: () => string | undefined;
  sessionLockManager?: SessionLockManager;
  sessionLockOwnerKind?: OwnerKind;
  /**
   * Stage B (260417_approval_consolidation_closeout): optional capability-token
   * service. When present, `memory:staging-mint-conflict-capability` is
   * registered and `memory:staging-resolve-conflict` requires a valid token.
   * When absent, the resolve handler rejects with `CAPABILITY_UNAVAILABLE`
   * so we fail closed even if bootstrap wiring is skipped.
   */
  conflictCapabilityService?: ConflictCapabilityService;
  /**
   * Stage C (260417_approval_consolidation_closeout): optional IPC dedup
   * cache. When present, the 4 staging handlers (`publish`, `discard`,
   * `keep-private`, `resolve-conflict`) replay the first response for
   * any retry arriving within the TTL carrying the same
   * `clientDedupKey`. When absent or when the caller omits the key, the
   * handlers run as normal — no dedup is applied. Intentionally silent
   * fallback because dedup is defense-in-depth on top of the store's
   * existing `isIdempotentSuccess` handling.
   */
  ipcDedupService?: IpcDedupService;
}

/**
 * Stage C helper: wrap a handler body with a peek → early return +
 * record pattern. No-ops (i.e. runs the body directly) when the service
 * isn't wired or the caller didn't attach a `clientDedupKey`.
 *
 * Error-caching policy: we cache whatever value the body RETURNED,
 * including `{ status: 'error', ... }`. Exceptions are NOT cached — they
 * propagate to the handler registry as normal and the next retry runs
 * the body again. Mirrors the "same input → same output within TTL"
 * contract that makes dedup safe for non-idempotent mutations.
 */
async function withDedup<T>(
  service: IpcDedupService | undefined,
  channel: string,
  dedupKey: string | undefined,
  body: () => Promise<T>,
): Promise<T> {
  if (!service || !isNonEmptyString(dedupKey)) {
    return body();
  }
  const cached = service.peek(channel, dedupKey);
  if (cached !== undefined) {
    log.info({ channel, key: dedupKey }, 'IPC dedup hit — replaying cached response');
    return cached as T;
  }
  const response = await body();
  service.record(channel, dedupKey, response);
  return response;
}

let deps: MemoryHandlerDeps = {};

function requireSessionLockingDeps(): {
  lockManager: SessionLockManager;
  ownerKind: OwnerKind;
} {
  if (!deps.sessionLockManager || !deps.sessionLockOwnerKind) {
    throw new Error('Session lock manager is not configured for memory status persistence');
  }
  return {
    lockManager: deps.sessionLockManager,
    ownerKind: deps.sessionLockOwnerKind,
  };
}

export function registerMemoryHandlers(handlerDeps: MemoryHandlerDeps = {}): void {
  log.info('registerMemoryHandlers called');
  deps = handlerDeps;

  registerHandler(
    'memoryUpdate:applyStatusToSession',
    async (
      _event: HandlerInvokeEvent,
      payload: { sessionId: string; turnId: string; status: MemoryUpdateStatus },
    ) => {
      return applyMemoryUpdateStatusToSession(payload);
    },
  );

  registerHandler(
    'timeSaved:applyTimeSavedStatusToSession',
    async (
      _event: HandlerInvokeEvent,
      payload: { sessionId: string; turnId: string; status: TimeSavedStatus },
    ) => {
      return applyTimeSavedStatusToSession(payload);
    },
  );

  registerHandler(
    'memory:get-history',
    async (
      _event: HandlerInvokeEvent,
      payload: { space?: string; limit?: number; beforeTimestamp?: number }
    ) => {
      await repairStaleFilePathsIfNeeded(deps.getWorkspacePath?.());
      const options = {
        space: payload?.space,
        limit: payload?.limit ?? 100,
        beforeTimestamp: payload?.beforeTimestamp,
      };
      return getMemoryHistory(options);
    }
  );

  registerHandler('memory:get-stats', async (_event: HandlerInvokeEvent) => {
    const workspacePath = deps.getWorkspacePath?.();
    return await getMemoryStats(workspacePath);
  });

  registerHandler('memory:get-history-count', (_event: HandlerInvokeEvent) => {
    return { count: getMemoryHistoryCount() };
  });

  registerHandler(
    'memory:get-entry',
    (_event: HandlerInvokeEvent, payload: { entryId: string }) => {
      if (!payload || !isNonEmptyString(payload.entryId)) {
        return { entry: null };
      }
      const entry = getMemoryHistoryEntry(payload.entryId);
      return { entry };
    }
  );

  registerHandler(
    'memory:repair-entry-path',
    (
      _event: HandlerInvokeEvent,
      payload: { entryId: string; repairedFilePath: string },
    ) => {
      if (!payload || !isNonEmptyString(payload.entryId) || !isNonEmptyString(payload.repairedFilePath)) {
        return { success: false };
      }

      return {
        success: repairMemoryHistoryEntryPath(payload.entryId, payload.repairedFilePath),
      };
    },
  );

  registerHandler(
    'memory:forget-entry',
    async (_event: HandlerInvokeEvent, payload: { entryId: string }) => {
      if (!payload || !isNonEmptyString(payload.entryId)) {
        return { success: false, error: 'Invalid entry ID' };
      }

      const entry = getMemoryHistoryEntry(payload.entryId);
      if (!entry) {
        return { success: false, error: 'Entry not found' };
      }

      // If a trigger function is provided, use it to launch background agent
      if (deps.triggerForgetMemory) {
        try {
          const result = await deps.triggerForgetMemory(payload.entryId);
          return result;
        } catch (error) {
          log.error({ err: error, entryId: payload.entryId }, 'Failed to trigger forget memory');
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to forget memory',
          };
        }
      }

      // Fallback: just remove from history without modifying files
      const removed = removeMemoryHistoryEntry(payload.entryId);
      return { success: removed };
    }
  );

  // Get persisted pending memory approvals (survives app restart)
  log.info('Registering memory:get-pending-approvals handler');
  registerHandler('memory:get-pending-approvals', async () => {
    log.debug('memory:get-pending-approvals handler called');
    const records = getPendingMemoryApprovals();
    const coreDirectory = getSettings()?.coreDirectory ?? undefined;
    const scannedSpaces = coreDirectory
      ? await scanSpaces(coreDirectory, { skipAutoFix: true })
      : [];
    const resolverSpaces: ResolverSpaceInfo[] = scannedSpaces.map((space) => ({
      ...space,
      status: space.status ?? 'ok',
    }));

    const projectedRecords: Array<
      ReturnType<typeof getPendingMemoryApprovals>[number] & { location: FileLocation; spacePath: string }
    > = [];

    for (const record of records) {
      let location: FileLocation;
      const parsedLocation = record.location
        ? FileLocationSchema.safeParse(record.location)
        : null;
      const storedLocation = parsedLocation?.success && parsedLocation.data.kind !== 'legacy-missing-location'
        ? parsedLocation.data
        : null;

      if (record.location && parsedLocation && !parsedLocation.success) {
        warnInvalidStoredLocationOnce({
          filePath: record.filePath,
          coreDirectory,
        });
      }

      try {
        location = await resolveFileLocation(record.filePath, resolverSpaces, { coreDirectory });
      } catch (error) {
        if (error instanceof FileLocationResolverError) {
          if (storedLocation) {
            warnResolverFailedStoredReuseOnce({
              filePath: record.filePath,
              coreDirectory,
              errorMessage: error.message,
            });
            location = storedLocation;
          } else {
            log.error(
              {
                err: error,
                filePath: record.filePath,
                originalSpace: record.spaceName,
                coreDirectory,
                handler: 'memory:get-pending-approvals',
              },
              'Skipping pending memory approval row due FileLocationResolverError',
            );
            continue;
          }
        } else {
          throw error;
        }
      }

      if (storedLocation && !fileLocationsMatch(storedLocation, location)) {
        debugStoredLocationMismatchOnce({
          filePath: record.filePath,
          storedLocation,
          recomputedLocation: location,
        });
      }

      if (location.kind === 'legacy-missing-location') {
        log.error(
          {
            filePath: record.filePath,
            originalSpace: record.spaceName,
            coreDirectory,
            handler: 'memory:get-pending-approvals',
          },
          'Skipping pending memory approval row because producer returned forbidden legacy-missing-location',
        );
        continue;
      }

      if (location.kind === 'outside-workspace') {
        warnFileLocationFallbackOnce({
          pendingDestination: record.filePath,
          originalSpace: record.spaceName,
          coreDirectory,
          handler: 'memory:get-pending-approvals',
        });
      }

      projectedRecords.push({
        ...record,
        spaceName: location.kind === 'in-space' ? location.spaceName : record.spaceName,
        spacePath: location.kind === 'in-space' ? location.workspaceRelativePath : location.absolutePath,
        location,
      });
    }

    return projectedRecords;
  });

  // Phase 2: Memory write approval response (with destination)
  // Stores approval and returns metadata for continuation message
  registerHandler(
    'memory:write-approval-response',
    (
      _event: HandlerInvokeEvent,
      payload: { toolUseId: string; approved: boolean }
    ) => {
      if (!payload || !isNonEmptyString(payload.toolUseId)) {
        log.error({ payload }, 'Invalid memory write approval response payload');
        return { success: false, error: 'Invalid memory approval request.' };
      }

      log.info(
        { toolUseId: payload.toolUseId, approved: payload.approved },
        'Received memory write approval response'
      );

      // Store approval and return metadata - renderer sends continuation to trigger retry
      const result = handleMemoryWriteApprovalResponse(payload.toolUseId, payload.approved);

      // Track resolution in automation pending items tracker (memory-write items)
      if (isAutomationFamilySession(result.originalSessionId)) {
        const automationContext = getAutomationContext(result.originalSessionId);
        if (automationContext) {
          resolveItem(automationContext.automationId, payload.toolUseId, payload.approved ? 'approved' : 'rejected');
        }
      }

      // Broadcast resolved event to all windows for real-time sync across surfaces.
      // Always broadcast (even when originalSessionId is absent, e.g. E2E-injected
      // approvals) so the renderer can remove the card from pending state.
      broadcastMemoryApprovalResolved(payload.toolUseId, result.originalSessionId ?? '', payload.approved);

      return result;
    }
  );

  // ============================================================================
  // Staged Writes Handlers (CoS Pending)
  // ============================================================================

  /**
   * Normalize CoS conflict response to legacy UI format.
   * CoS returns: { currentContent, pendingContent }
   * UI expects: { realContent, stagedContent }
   */
  function normalizeConflictResponse(result: PublishResult): {
    status: 'success' | 'conflict' | 'not-found' | 'error' | 'invalid-destination' | 'already-resolved';
    error?: string;
    conflict?: { realContent: string; stagedContent: string };
  } {
    if (result.status === 'conflict' && result.conflict) {
      return {
        status: 'conflict',
        conflict: {
          realContent: result.conflict.currentContent,
          stagedContent: result.conflict.pendingContent,
        },
      };
    }
    return result as ReturnType<typeof normalizeConflictResponse>;
  }

  // Get all staged files (for Pending Changes panel)
  // Returns files from CoS pending folder
  registerHandler('memory:staging-get-all', async () => {
    log.debug('Getting all staged files');
    
    const settings = getSettings();
    const coreDirectory = settings?.coreDirectory ?? undefined;
    
    // Normalize pending files to the expected StagedFile shape for the UI
    interface NormalizedStagedFile {
      id: string;
      realPath: string;
      /** Workspace-relative destination path (from frontmatter pending_destination) */
      pendingDestination: string;
      spaceName: string;
      spacePath: string;
      location: FileLocation;
      sessionId: string;
      baseHash: string;
      summary: string;
      stagedAt: number;
      sensitivity: 'high';
      sharing?: string;
      blockedBy?: BlockSource;
      /** Conflict detected upfront - destination file was modified or created since staging */
      hasConflict?: boolean;
      approvalKind?: 'memory_write' | 'shared_skill_checkpoint';
      authorLabel?: string;
      toolUseId?: string;
    }
    
    const allFiles: NormalizedStagedFile[] = [];
    
    // Skip if no workspace configured (can't resolve absolute paths)
    if (!coreDirectory) {
      log.debug('No coreDirectory configured, returning empty staged files list');
      return { files: allFiles };
    }
    
    const pendingFiles = await listPendingFiles();
    const scannedSpaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
    const resolverSpaces: ResolverSpaceInfo[] = scannedSpaces.map((space) => ({
      ...space,
      status: space.status ?? 'ok',
    }));
    for (const pf of pendingFiles) {
      // Convert workspace-relative pending_destination to absolute path
      const pendingDest = pf.frontmatter.pending_destination;
      const absolutePath = path.isAbsolute(pendingDest)
        ? pendingDest
        : path.join(coreDirectory, pendingDest);
      
      // Detect conflicts upfront so UI can show appropriate state immediately.
      // Uses shared helper to ensure consistency with publishPendingFile().
      // Note: This hashes each destination file on every load. Acceptable for typical
      // usage (1-5 pending files) but could be optimized with caching if volume grows.
      const conflict = await detectPendingConflict(pf.frontmatter.base_hash, absolutePath);
      
      if (conflict.hasConflict) {
        log.debug(
          { id: pf.id, absolutePath, fileModifiedSinceStaging: conflict.fileModifiedSinceStaging, newFileConflict: conflict.newFileConflict },
          'Conflict detected during staged file listing'
        );
      }

      const originalSpace = pf.frontmatter.original_space || 'Memory';
      let location: FileLocation;
      try {
        location = await resolveFileLocation(pendingDest, resolverSpaces, { coreDirectory });
      } catch (error) {
        if (error instanceof FileLocationResolverError) {
          log.error(
            {
              err: error,
              pendingDestination: pendingDest,
              originalSpace,
              coreDirectory,
              handler: 'memory:staging-get-all',
            },
            'Skipping staged file row due FileLocationResolverError',
          );
          continue;
        }
        throw error;
      }

      if (location.kind === 'legacy-missing-location') {
        log.error(
          {
            pendingDestination: pendingDest,
            originalSpace,
            coreDirectory,
            handler: 'memory:staging-get-all',
          },
          'Skipping staged file row because producer returned forbidden legacy-missing-location',
        );
        continue;
      }

      if (location.kind === 'outside-workspace') {
        warnFileLocationFallbackOnce({
          pendingDestination: pendingDest,
          originalSpace,
          coreDirectory,
          handler: 'memory:staging-get-all',
        });
      }
      
      allFiles.push({
        id: pf.id,
        realPath: absolutePath,
        pendingDestination: pf.frontmatter.pending_destination,
        spaceName: location.kind === 'in-space' ? location.spaceName : originalSpace,
        spacePath: location.kind === 'in-space' ? location.workspaceRelativePath : location.absolutePath,
        location,
        sessionId: pf.frontmatter.session_id,
        baseHash: pf.frontmatter.base_hash,
        summary: pf.frontmatter.summary,
        stagedAt: new Date(pf.frontmatter.staged_at).getTime(),
        sensitivity: 'high',
        sharing: pf.frontmatter.sharing,
        blockedBy: pf.frontmatter.blocked_by,
        hasConflict: conflict.hasConflict,
        approvalKind: pf.frontmatter.approval_kind,
        authorLabel: pf.frontmatter.author_label,
        toolUseId: pf.frontmatter.tool_use_id,
      });
    }
    
    return { files: allFiles };
  });

  // Get staged content for a specific file (for diff view)
  registerHandler(
    'memory:staging-get-content',
    async (_event: HandlerInvokeEvent, payload: { id: string }) => {
      if (!payload || !isNonEmptyString(payload.id)) {
        return { content: null, error: 'Invalid staged file ID' };
      }
      
      const content = await getPendingContent(payload.id);
      return { content };
    }
  );

  // Approve a single staged file
  registerHandler(
    'memory:staging-publish',
    async (
      _event: HandlerInvokeEvent,
      payload: { id: string; clientDedupKey?: string },
    ) => {
      if (!payload || !isNonEmptyString(payload.id)) {
        return { status: 'error' as const, error: 'Invalid staged file ID' };
      }
      return withDedup(
        deps.ipcDedupService,
        'memory:staging-publish',
        payload.clientDedupKey,
        async () => {
          log.info({ id: payload.id }, 'Approving staged file');

          // Snapshot the pending file BEFORE publishing (publishPendingFile deletes it)
          const pendingFile = await getPendingFile(payload.id);

          // Route shared skill checkpoints through managed write (FM #2, Stage 3A)
          let result: PublishResult;
          const sharedSkillResult = pendingFile ? await tryPublishAsSharedSkill(pendingFile) : null;
          if (sharedSkillResult) {
            result = sharedSkillResult;
          } else {
            result = await publishPendingFile(payload.id);
          }

          if (result.status === 'success' || result.status === 'already-resolved') {
            broadcastStagedFilesChanged();

            // Track resolution in automation pending items tracker (CoS pending memory writes)
            const pendingSessionId = pendingFile?.frontmatter.session_id;
            if (isAutomationFamilySession(pendingSessionId)) {
              const automationContext = getAutomationContext(pendingSessionId);
              if (automationContext) {
                resolveItem(automationContext.automationId, payload.id, 'approved');
              }
            }

            // Emit deferred transcript event if this was a staged transcript
            if (pendingFile) {
              const settings = getSettings();
              const coreDirectory = settings?.coreDirectory;
              if (coreDirectory) {
                tryEmitDeferredTranscriptEvent(
                  pendingFile.frontmatter.pending_destination,
                  pendingFile.frontmatter.pending_transcript_meta,
                  coreDirectory,
                );
              }
            }

            // Clean up stale approval metadata for staged files (Stage 3A step 6)
            if (pendingFile) {
              cleanupStagedApproval(pendingFile, true);
            }
          }

          // Normalize conflict response shape for UI compatibility
          return normalizeConflictResponse(result);
        },
      );
    }
  );

  // Discard a single staged file
  registerHandler(
    'memory:staging-discard',
    async (
      _event: HandlerInvokeEvent,
      payload: { id: string; clientDedupKey?: string },
    ) => {
      if (!payload || !isNonEmptyString(payload.id)) {
        return { status: 'error' as const, error: 'Invalid staged file ID' };
      }
      return withDedup(
        deps.ipcDedupService,
        'memory:staging-discard',
        payload.clientDedupKey,
        async () => {
          log.info({ id: payload.id }, 'Discarding staged file');

          // Snapshot pending file before deletion for deferred event cleanup
          const pendingFile = await getPendingFile(payload.id);

          const result = await deletePendingFile(payload.id);

          if (result.status === 'success') {
            broadcastStagedFilesChanged();

            // Track rejection in automation pending items tracker (CoS pending memory writes)
            const pendingSessionId = pendingFile?.frontmatter.session_id;
            if (isAutomationFamilySession(pendingSessionId)) {
              const automationContext = getAutomationContext(pendingSessionId);
              if (automationContext) {
                resolveItem(automationContext.automationId, payload.id, 'rejected');
              }
            }

            // Clean up any deferred transcript event for this file
            if (pendingFile) {
              const settings = getSettings();
              const coreDirectory = settings?.coreDirectory;
              if (coreDirectory) {
                cleanupDeferredTranscriptEvent(pendingFile.frontmatter.pending_destination, coreDirectory);
              }
            }

            // Clean up stale approval metadata for staged files (Stage 3A step 6)
            if (pendingFile) {
              cleanupStagedApproval(pendingFile, false);
            }
          }

          return result;
        },
      );
    }
  );

  // Keep a staged file private (move to Chief-of-Staff memory/topics)
  registerHandler(
    'memory:staging-keep-private',
    async (
      _event: HandlerInvokeEvent,
      payload: { id: string; clientDedupKey?: string },
    ) => {
      if (!payload || !isNonEmptyString(payload.id)) {
        return { status: 'error' as const, error: 'Invalid staged file ID' };
      }
      return withDedup(
        deps.ipcDedupService,
        'memory:staging-keep-private',
        payload.clientDedupKey,
        async () => {
          log.info({ id: payload.id }, 'Keeping staged file private');

          // Snapshot pending file before keep-private for deferred event cleanup
          const pendingFile = await getPendingFile(payload.id);

          const result = await keepPendingFilePrivate(payload.id);

          if (result.status === 'success' || result.status === 'already-resolved') {
            broadcastStagedFilesChanged();

            // Track rejection in automation pending items tracker (keeping private = not publishing to intended destination)
            const pendingSessionId = pendingFile?.frontmatter.session_id;
            if (isAutomationFamilySession(pendingSessionId)) {
              const automationContext = getAutomationContext(pendingSessionId);
              if (automationContext) {
                resolveItem(automationContext.automationId, payload.id, 'rejected');
              }
            }

            // Clean up any deferred transcript event (file kept private, not published to destination)
            if (pendingFile) {
              const settings = getSettings();
              const coreDirectory = settings?.coreDirectory;
              if (coreDirectory) {
                cleanupDeferredTranscriptEvent(pendingFile.frontmatter.pending_destination, coreDirectory);
              }
            }

            // Clean up stale approval metadata for staged files (Stage 3A step 6)
            if (pendingFile) {
              cleanupStagedApproval(pendingFile, false);
            }
          }

          return result;
        },
      );
    }
  );

  // Discard all staged files (batch operation)
  registerHandler('memory:staging-discard-all', async () => {
    log.info('Discarding all staged files');
    
    const pendingFiles = await listPendingFiles();
    const settings = getSettings();
    const coreDirectory = settings?.coreDirectory;
    
    for (const file of pendingFiles) {
      try {
        await deletePendingFile(file.id);

        // Track rejection in automation pending items tracker
        if (isAutomationFamilySession(file.frontmatter.session_id)) {
          const automationContext = getAutomationContext(file.frontmatter.session_id);
          if (automationContext) {
            resolveItem(automationContext.automationId, file.id, 'rejected');
          }
        }

        // Clean up any deferred transcript events
        if (coreDirectory) {
          cleanupDeferredTranscriptEvent(file.frontmatter.pending_destination, coreDirectory);
        }

        // Clean up stale approval metadata for staged files (Stage 3A step 6)
        cleanupStagedApproval(file, false);
      } catch (err) {
        log.warn({ err, id: file.id }, 'Failed to discard pending file');
      }
    }
    
    broadcastStagedFilesChanged();
    return { success: true };
  });

  // Approve all staged files (batch operation)
  registerHandler('memory:staging-publish-all', async () => {
    log.info('Approving all staged files');
    
    const pendingFiles = await listPendingFiles();
    const settings = getSettings();
    const coreDirectory = settings?.coreDirectory;
    const result: { published: string[]; conflicts: string[]; errors: string[] } = {
      published: [],
      conflicts: [],
      errors: [],
    };
    
    for (const file of pendingFiles) {
      try {
        // Snapshot frontmatter before publish (publishPendingFile deletes the file)
        const { pending_destination: pendingDestination, pending_transcript_meta: pendingTranscriptMeta } = file.frontmatter;

        // Route shared skill checkpoints through managed write (FM #2, Stage 3A)
        let publishResult: PublishResult;
        const sharedSkillResult = await tryPublishAsSharedSkill(file);
        if (sharedSkillResult) {
          publishResult = sharedSkillResult;
        } else {
          publishResult = await publishPendingFile(file.id);
        }
        
        if (publishResult.status === 'success' || publishResult.status === 'already-resolved') {
          result.published.push(file.id);

          // Track approval in automation pending items tracker
          if (isAutomationFamilySession(file.frontmatter.session_id)) {
            const automationContext = getAutomationContext(file.frontmatter.session_id);
            if (automationContext) {
              resolveItem(automationContext.automationId, file.id, 'approved');
            }
          }

          // Emit deferred transcript event if this was a staged transcript
          if (coreDirectory) {
            tryEmitDeferredTranscriptEvent(pendingDestination, pendingTranscriptMeta, coreDirectory);
          }

          // Clean up stale approval metadata for staged files (Stage 3A step 6)
          cleanupStagedApproval(file, true);
        } else if (publishResult.status === 'conflict') {
          result.conflicts.push(file.id);
        } else {
          result.errors.push(file.id);
        }
      } catch (err) {
        log.warn({ err, id: file.id }, 'Failed to publish pending file');
        result.errors.push(file.id);
      }
    }
    
    broadcastStagedFilesChanged();
    return result;
  });

  // Stage B (260417_approval_consolidation_closeout): mint a short-lived,
  // one-time-use capability token. The UI mints before calling
  // `memory:staging-resolve-conflict`, which is the only way the agent
  // can reach the resolve handler without tripping the CAPABILITY_* gate.
  registerHandler(
    'memory:staging-mint-conflict-capability',
    async (
      _event: HandlerInvokeEvent,
      payload: { stagedFileId: string }
    ) => {
      if (!payload || !isNonEmptyString(payload.stagedFileId)) {
        return { success: false as const, error: 'UNKNOWN_STAGED_FILE' as const };
      }
      if (!deps.conflictCapabilityService) {
        // Fail-closed telemetry: an unwired service is an operational
        // bug, not a product state. `SERVICE_UNAVAILABLE` keeps the
        // `READ_ONLY` code reserved for a real product-level gate.
        log.warn(
          { stagedFileId: payload.stagedFileId },
          'memory:staging-mint-conflict-capability called but no ConflictCapabilityService is wired',
        );
        return { success: false as const, error: 'SERVICE_UNAVAILABLE' as const };
      }

      // Validate the staged file actually exists before minting. A token
      // for a non-existent file would still be rejected at resolve time,
      // but failing here gives the UI a cleaner error code to surface.
      const pendingFile = await getPendingFile(payload.stagedFileId);
      if (!pendingFile) {
        log.info(
          { stagedFileId: payload.stagedFileId },
          'Refused to mint capability token for unknown staged file',
        );
        return { success: false as const, error: 'UNKNOWN_STAGED_FILE' as const };
      }

      try {
        const { token, expiresAt } = deps.conflictCapabilityService.mint({
          stagedFileId: payload.stagedFileId,
        });
        log.info(
          { stagedFileId: payload.stagedFileId, expiresAt },
          'Minted conflict-resolution capability token',
        );
        return { success: true as const, token, expiresAt };
      } catch (err) {
        // Defense-in-depth: the Zod schema already caps the id at 256
        // chars, so a RangeError here means the id slipped past schema
        // validation (malformed input). Surface INVALID_INPUT rather
        // than conflating with UNKNOWN_STAGED_FILE so clients can
        // distinguish "this id doesn't exist" from "this id is bad".
        log.warn(
          { err, stagedFileId: payload.stagedFileId },
          'Failed to mint conflict-resolution capability token',
        );
        return { success: false as const, error: 'INVALID_INPUT' as const };
      }
    }
  );

  // Resolve conflict by keeping staged or real content
  registerHandler(
    'memory:staging-resolve-conflict',
    async (
      _event: HandlerInvokeEvent,
      payload: {
        id: string;
        resolution: 'keep-staged' | 'keep-real';
        capabilityToken: string;
        clientDedupKey?: string;
      }
    ) => {
      if (!payload || !isNonEmptyString(payload.id)) {
        return { status: 'error' as const, error: 'Invalid staged file ID' };
      }
      if (!['keep-staged', 'keep-real'].includes(payload.resolution)) {
        return { status: 'error' as const, error: 'Invalid resolution' };
      }
      // Stage B gate: a jailbroken agent that reaches this handler
      // directly (bypassing the conversational seed prompt) will not
      // have minted a token. Validate BEFORE any dedup cache check so
      // structural / configuration errors never poison the cache.
      // Same for the "service not wired" failure — it's an operational
      // bug, not a legitimate response worth replaying.
      if (!isNonEmptyString(payload.capabilityToken)) {
        log.warn(
          { id: payload.id },
          'memory:staging-resolve-conflict called without capability token',
        );
        return { status: 'error' as const, error: 'CAPABILITY_MALFORMED' };
      }
      if (!deps.conflictCapabilityService) {
        // Fail closed — if the service isn't wired, the handler MUST NOT
        // silently bypass the gate. Bootstrap is responsible for wiring
        // on both desktop + cloud.
        log.warn(
          { id: payload.id },
          'memory:staging-resolve-conflict rejected — ConflictCapabilityService not wired',
        );
        return { status: 'error' as const, error: 'CAPABILITY_UNAVAILABLE' };
      }
      // Stage C note: dedup wraps the rest of the handler so a replay of
      // a successful resolve replays the original response WITHOUT
      // re-consuming the capability token (which Stage B marks
      // one-time-use — replaying would otherwise land as
      // CAPABILITY_REUSED). The structural short-circuits above sit
      // OUTSIDE the wrapper so nonsense inputs never poison the cache.
      // Actual validate() outcomes (REUSED / EXPIRED / SCOPE_MISMATCH /
      // INVALID_SIGNATURE) ARE cached — those represent the real
      // server response for that `(channel, dedupKey)` pair.
      return withDedup(
        deps.ipcDedupService,
        'memory:staging-resolve-conflict',
        payload.clientDedupKey,
        async () => {
          // Narrow for the inner scope — the outer check already
          // guaranteed the service is wired.
          const capabilityService = deps.conflictCapabilityService;
          if (!capabilityService) {
            return { status: 'error' as const, error: 'CAPABILITY_UNAVAILABLE' };
          }
          const verdict = capabilityService.validate({
            token: payload.capabilityToken,
            stagedFileId: payload.id,
          });
          if (!verdict.ok) {
            log.warn(
              { id: payload.id, code: verdict.code },
              'memory:staging-resolve-conflict rejected — capability-token validation failed',
            );
            return { status: 'error' as const, error: `CAPABILITY_${verdict.code}` };
          }

          log.info({ id: payload.id, resolution: payload.resolution }, 'Resolving staging conflict');

          // Snapshot pending file before resolution (publishPendingFile deletes it on success)
          const pendingFile = await getPendingFile(payload.id);

          // Map UI resolution values to CoS pending values
          // UI sends: 'keep-real' or 'keep-staged'
          // CoS expects: 'keep-current' (for real) or 'keep-pending' (for staged)
          const cosPendingResolution = payload.resolution === 'keep-staged' ? 'keep-pending' : 'keep-current';

          const result = await publishPendingWithConflict(payload.id, cosPendingResolution);

          if (result.status === 'success' || result.status === 'already-resolved') {
            broadcastStagedFilesChanged();

            // Track resolution in automation pending items tracker
            // keep-staged = approved (user chose to publish the automation's content)
            // keep-real = rejected (user discarded the automation's content)
            const pendingSessionId = pendingFile?.frontmatter.session_id;
            if (isAutomationFamilySession(pendingSessionId)) {
              const automationContext = getAutomationContext(pendingSessionId);
              if (automationContext) {
                const resolution = payload.resolution === 'keep-staged' ? 'approved' : 'rejected';
                resolveItem(automationContext.automationId, payload.id, resolution);
              }
            }

            // Emit deferred transcript event if keep-staged resolved successfully
            if (payload.resolution === 'keep-staged' && pendingFile) {
              const settings = getSettings();
              const coreDirectory = settings?.coreDirectory;
              if (coreDirectory) {
                tryEmitDeferredTranscriptEvent(
                  pendingFile.frontmatter.pending_destination,
                  pendingFile.frontmatter.pending_transcript_meta,
                  coreDirectory,
                );
              }
            }
            // Clean up deferred event if user chose to keep real (discarding staged content)
            if (payload.resolution === 'keep-real' && pendingFile) {
              const settings = getSettings();
              const coreDirectory = settings?.coreDirectory;
              if (coreDirectory) {
                cleanupDeferredTranscriptEvent(pendingFile.frontmatter.pending_destination, coreDirectory);
              }
            }

            // Clean up stale approval metadata for staged files (Stage 3A step 6)
            if (pendingFile) {
              const approved = payload.resolution === 'keep-staged';
              cleanupStagedApproval(pendingFile, approved);
            }
          }

          // Normalize conflict response shape for UI compatibility (in case of subsequent conflict)
          return normalizeConflictResponse(result);
        },
      );
    }
  );

  // Cleanup endpoint - no longer needed with CoS pending (files don't expire)
  // Keep the handler for API compatibility but return 0 cleaned
  registerHandler('memory:staging-cleanup', async () => {
    log.debug('Staging cleanup called (no-op for CoS pending)');
    return { cleanedCount: 0 };
  });
}

/** Broadcast staged files changed event to all renderer windows */
function broadcastStagedFilesChanged(): void {
  getBroadcastService().sendToAllWindows('memory:staged-files-changed');
}
