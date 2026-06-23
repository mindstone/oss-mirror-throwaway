import type { AgentSession } from '@shared/types';
import type { IncrementalSessionStore } from '@core/services/incrementalSessionStore';
import type { OwnerKind } from '@core/services/superMcpOwnerRegistry';
import type { SessionLockManager } from '@core/utils/sessionFileLock';
import { LockAcquireTimeout } from '@core/utils/sessionFileLock';
import { createScopedLogger } from '@core/logger';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { buildCliSessionSnapshot } from './cliSessionSnapshot';

const log = createScopedLogger({ service: 'persistSessionFromCli' });
// CLI waits past common 400-600ms cloud-FS holds and the observed 3.4s tail, but far below 60s stale reclaim.
const CLI_LOCK_ACQUIRE_BUDGET_MS = 5_000;

export type SessionModifiedExternallyResult = {
  kind: 'session_modified_externally';
  sessionId: string;
  expectedUpdatedAt: number | undefined;
  currentUpdatedAt: number;
  currentMessageCount: number;
  deltaMessages: number;
};

/**
 * Stage 2/3 dropped-write contract, CLI surface (final-review F1): the store
 * refused the write — tombstoned id (hard-deleted; delete-wins), read-only
 * store (breaker trip / shutdown latch / forward-version protection), or a
 * corrupt-index abort. A drop must NOT report `{ persistedSession }` or fire
 * the embedding/cloud callbacks; callers see this typed result instead.
 */
export type SessionPersistDroppedResult = {
  kind: 'session_persist_dropped';
  sessionId: string;
  reason:
    | 'tombstoned'
    | 'read-only'
    | 'corrupt-index-unrecoverable'
    | 'version-forward-index'
    // The on-disk index was present but TRANSIENTLY unreadable (EMFILE/IO) during
    // the reload-before-write; the batch write was deferred to avoid shrinking
    // the corpus (the session file is written, picked up by orphan-recovery /
    // next full load). Mirrors the SessionsSyncUpsertOutcome 'transient-index-read'.
    | 'transient-index-read';
};

export type SessionPersistContentionResult = {
  kind: 'session_persist_contention';
  sessionId: string;
  lockPath: string;
  existingPid?: number;
  ageMs?: number;
};

export class CliSessionModifiedExternallyError extends Error {
  readonly details: SessionModifiedExternallyResult;

  constructor(details: SessionModifiedExternallyResult) {
    super(`Session ${details.sessionId} was modified externally.`);
    this.name = 'CliSessionModifiedExternallyError';
    this.details = details;
  }
}

/** Thrown by headless runners when the store dropped the CLI session write. */
export class CliSessionPersistDroppedError extends Error {
  readonly details: SessionPersistDroppedResult;

  constructor(details: SessionPersistDroppedResult) {
    super(
      `Session ${details.sessionId} was not persisted — the store dropped the write (${details.reason}).`,
    );
    this.name = 'CliSessionPersistDroppedError';
    this.details = details;
  }
}

/** Thrown by headless runners when another process holds the CLI session store lock. */
export class CliSessionContentionError extends Error {
  readonly details: SessionPersistContentionResult;

  constructor(details: SessionPersistContentionResult) {
    super(`Session ${details.sessionId} could not be persisted because another process is writing the session store.`);
    this.name = 'CliSessionContentionError';
    this.details = details;
  }
}

export async function persistSessionFromCli(args: {
  turnId: string;
  sessionId: string;
  store: IncrementalSessionStore;
  lockManager: SessionLockManager;
  ownerKind: OwnerKind;
  registry?: typeof agentTurnRegistry;
  resetConversation?: boolean;
  onSessionsSaved?: (sessions: AgentSession[]) => void | Promise<void>;
  onSessionsSavedLocally?: (sessions: AgentSession[]) => void | Promise<void>;
}): Promise<
  | { persistedSession: AgentSession }
  | SessionModifiedExternallyResult
  | SessionPersistDroppedResult
  | SessionPersistContentionResult
> {
  const startingSession = (await args.store.getSession(args.sessionId)) ?? undefined;
  const expectedUpdatedAt = startingSession?.updatedAt;
  const expectedMessageCount = startingSession?.messages.length ?? 0;
  // Lock-acquire contention invariant (260618 #17). Both acquires use the bounded
  // CLI budget and map ONLY `LockAcquireTimeout` to a typed contention result
  // (`contentionResultOrThrow` rethrows every other error — no silent swallow).
  // Placement matters: the per-session acquire sits OUTSIDE the outer try/finally,
  // so on its failure no lock is held and returning is safe. The global-index
  // acquire (below) sits INSIDE that try, so its contention `return` still runs the
  // `finally` that releases the already-held per-session lock. Preserve this shape.
  let perSessionLock: Awaited<ReturnType<SessionLockManager['acquirePerSession']>>;
  try {
    perSessionLock = await args.lockManager.acquirePerSession(args.sessionId, lockOptions(args.ownerKind));
  } catch (err) {
    return contentionResultOrThrow(err, args);
  }

  try {
    const currentSession = (await args.store.getSession(args.sessionId)) ?? undefined;
    if (hasAdvanced(expectedUpdatedAt, currentSession?.updatedAt)) {
      return {
        kind: 'session_modified_externally',
        sessionId: args.sessionId,
        expectedUpdatedAt,
        currentUpdatedAt: currentSession.updatedAt,
        currentMessageCount: currentSession.messages.length,
        deltaMessages: currentSession.messages.length - expectedMessageCount,
      };
    }

    const snapshot = buildCliSessionSnapshot({
      turnId: args.turnId,
      sessionId: args.sessionId,
      existingSession: args.resetConversation ? undefined : currentSession,
      registry: args.registry ?? agentTurnRegistry,
      now: Date.now,
    });

    // 260618 RC-3 F1b: this acquires the SAME global `index.lock` as the
    // desktop writers in `lockedSessionPersistence.ts`, but is deliberately NOT
    // enrolled in that module's in-process `globalIndexTail`. That tail only
    // makes SAME-process `index.lock` contention unrepresentable, and this path
    // runs ONLY in the headless CLI process (`runHeadlessTurn` with
    // `persistMode.kind === 'cli-session'`, wired solely under the
    // `isHeadlessCli()` gate in main/index.ts — which never boots the renderer,
    // so the renderer-driven `lockedSessionPersistence` writers do not run in
    // THIS process). Contention between a headless-CLI process and a
    // concurrently-running desktop process against a shared userData locks dir
    // is genuine CROSS-process contention — guarded here by the file lock, which
    // is its legitimate job; the in-process tail neither helps nor applies.
    let indexLock: Awaited<ReturnType<SessionLockManager['acquireGlobalIndex']>>;
    try {
      indexLock = await args.lockManager.acquireGlobalIndex(lockOptions(args.ownerKind));
    } catch (err) {
      return contentionResultOrThrow(err, args);
    }
    let outcome: ReturnType<IncrementalSessionStore['upsertSessionsSyncWithReload']>;
    try {
      outcome = args.store.upsertSessionsSyncWithReload([snapshot]);
    } finally {
      await indexLock.release();
    }

    // Stage 2/3 dropped-write contract (final-review F1): consume the
    // discriminated outcome — a write the store refused (tombstoned id,
    // read-only, corrupt/forward-version index abort) must not report success
    // or fire the callbacks below. Reachable here because getSession() hides a
    // tombstoned id while this path still builds a fresh snapshot for it.
    const dropped = classifyDroppedOutcome(outcome, args.sessionId);
    if (dropped) {
      log.error(
        { sessionId: args.sessionId, turnId: args.turnId, reason: dropped.reason, outcome: outcome.outcome },
        'CLI session persist DROPPED by the store — no callbacks, no persisted result',
      );
      return dropped;
    }

    // Callbacks invoked AFTER index lock release so a slow indexer or cloud-sync
    // hook never gates an unrelated CLI write trying to acquire the global lock.
    await invokeCallback('onSessionsSaved', args.onSessionsSaved, snapshot);
    await invokeCallback('onSessionsSavedLocally', args.onSessionsSavedLocally, snapshot);

    return { persistedSession: snapshot };
  } finally {
    await perSessionLock.release();
  }
}

function contentionResultOrThrow(
  err: unknown,
  args: { sessionId: string; turnId: string },
): SessionPersistContentionResult {
  if (!(err instanceof LockAcquireTimeout)) {
    throw err;
  }
  log.warn(
    {
      sessionId: args.sessionId,
      turnId: args.turnId,
      lockPath: err.lockPath,
      existingPid: err.existingPid,
      ageMs: err.ageMs,
    },
    'CLI session persist hit lock contention',
  );
  return {
    kind: 'session_persist_contention',
    sessionId: args.sessionId,
    lockPath: err.lockPath,
    ...(err.existingPid === undefined ? {} : { existingPid: err.existingPid }),
    ...(err.ageMs === undefined ? {} : { ageMs: err.ageMs }),
  };
}

/**
 * Map a non-persisted (or partially-persisted) store outcome to the typed CLI
 * drop result; returns null when this session's write genuinely landed.
 */
function classifyDroppedOutcome(
  outcome: ReturnType<IncrementalSessionStore['upsertSessionsSyncWithReload']>,
  sessionId: string,
): SessionPersistDroppedResult | null {
  switch (outcome.outcome) {
    case 'persisted':
      // Defensive: for a single-snapshot batch a missing id means it was
      // tombstone-dropped (the store reports per-session ids).
      return outcome.persistedSessionIds.includes(sessionId)
        ? null
        : { kind: 'session_persist_dropped', sessionId, reason: 'tombstoned' };
    case 'all-dropped-tombstoned':
      return { kind: 'session_persist_dropped', sessionId, reason: 'tombstoned' };
    case 'dropped':
      return { kind: 'session_persist_dropped', sessionId, reason: outcome.reason };
    case 'noop-empty-batch':
      // Structurally unreachable for the non-empty [snapshot] batch — fail
      // loud rather than fabricate success or a drop reason.
      throw new Error(
        `persistSessionFromCli: store reported noop-empty-batch for a non-empty batch (session ${sessionId})`,
      );
  }
}

function lockOptions(ownerKind: OwnerKind) {
  return {
    pid: process.pid,
    startedAt: Date.now(),
    ownerKind,
    maxRetryMs: CLI_LOCK_ACQUIRE_BUDGET_MS,
  };
}

function hasAdvanced(expectedUpdatedAt: number | undefined, currentUpdatedAt: number | undefined): currentUpdatedAt is number {
  if (currentUpdatedAt === undefined) return false;
  if (expectedUpdatedAt === undefined) return true;
  return currentUpdatedAt > expectedUpdatedAt;
}

async function invokeCallback(
  label: string,
  callback: ((sessions: AgentSession[]) => void | Promise<void>) | undefined,
  session: AgentSession,
): Promise<void> {
  if (!callback) return;
  try {
    await Promise.resolve(callback([session]));
  } catch (err) {
    log.warn({ err, sessionId: session.id, callback: label }, 'CLI session persist side effect failed');
  }
}
