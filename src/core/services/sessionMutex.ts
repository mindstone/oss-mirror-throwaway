import { fnvHashBase36 as hashForBreadcrumb } from '@rebel/shared';

import { getErrorReporter } from '@core/errorReporter';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import { toDiagnosticContinuityTransition } from '@shared/diagnostics/continuityTransition';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

const DEFAULT_CONTENTION_BREADCRUMB_MS = 200;
const DEFAULT_DEADLOCK_TIMEOUT_MS = 5_000;

export interface SessionMutexLockOptions {
  contentionBreadcrumbMs?: number;
  deadlockTimeoutMs?: number;
  label?: string;
}

export interface SessionMutex {
  withLock<T>(
    key: string,
    fn: () => Promise<T>,
    options?: SessionMutexLockOptions,
  ): Promise<T>;
}

export class SessionMutexDeadlockError extends Error {
  readonly key: string;
  readonly waitedMs: number;
  readonly deadlockTimeoutMs: number;
  readonly label?: string;

  constructor(args: {
    key: string;
    waitedMs: number;
    deadlockTimeoutMs: number;
    label?: string;
  }) {
    const labelSuffix = args.label ? ` (${args.label})` : '';
    super(
      `Session mutex deadlock timeout for key "${args.key}" after ${args.waitedMs}ms (limit ${args.deadlockTimeoutMs}ms)${labelSuffix}`,
    );
    this.name = 'SessionMutexDeadlockError';
    this.key = args.key;
    this.waitedMs = args.waitedMs;
    this.deadlockTimeoutMs = args.deadlockTimeoutMs;
    this.label = args.label;
  }
}

function recordSessionMutexContinuityBreadcrumb(args: {
  level: 'warning' | 'error';
  message: 'session-mutex-contention' | 'session-mutex-deadlock';
  data: Record<string, unknown>;
}): void {
  getErrorReporter().addBreadcrumb({
    category: 'continuity.continuity-state',
    level: args.level,
    message: args.message,
    data: args.data,
  });
  appendDiagnosticEvent(toDiagnosticContinuityTransition({
    family: 'session_mutex',
    category: 'continuity.continuity-state',
    level: args.level,
    message: args.message,
    data: args.data,
  }));
}

interface Waiter {
  enqueuedAt: number;
  deadlockTimeoutMs: number;
  label?: string;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (token: number) => void;
  reject: (error: Error) => void;
}

interface KeyState {
  locked: boolean;
  ownerToken: number | null;
  ownerLabel: string | null;
  ownerAcquiredAt: number | null;
  nextToken: number;
  queue: Waiter[];
}

class SessionMutexImpl implements SessionMutex {
  private readonly states = new Map<string, KeyState>();

  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    options?: SessionMutexLockOptions,
  ): Promise<T> {
    const contentionBreadcrumbMs = options?.contentionBreadcrumbMs ?? DEFAULT_CONTENTION_BREADCRUMB_MS;
    const deadlockTimeoutMs = options?.deadlockTimeoutMs ?? DEFAULT_DEADLOCK_TIMEOUT_MS;
    const label = options?.label;
    const waitStartedAt = Date.now();

    const token = await this.enqueueAndAcquire({
      key,
      deadlockTimeoutMs,
      label,
    });

    // release() must run for every acquired token, so the contention emit lives
    // inside the try: a throw from telemetry can never skip the release and strand
    // the lock. (emitContentionBreadcrumb is also no-throw by construction.)
    try {
      const waitedMs = Math.max(0, Date.now() - waitStartedAt);
      if (waitedMs > contentionBreadcrumbMs) {
        this.emitContentionBreadcrumb({ key, waitedMs, label });
      }
      return await fn();
    } finally {
      this.release(key, token);
    }
  }

  private getOrCreateState(key: string): KeyState {
    const existing = this.states.get(key);
    if (existing) return existing;
    const created: KeyState = {
      locked: false,
      ownerToken: null,
      ownerLabel: null,
      ownerAcquiredAt: null,
      nextToken: 0,
      queue: [],
    };
    this.states.set(key, created);
    return created;
  }

  private enqueueAndAcquire(args: {
    key: string;
    deadlockTimeoutMs: number;
    label?: string;
  }): Promise<number> {
    const state = this.getOrCreateState(args.key);

    return new Promise<number>((resolve, reject) => {
      const waiter: Waiter = {
        enqueuedAt: Date.now(),
        deadlockTimeoutMs: args.deadlockTimeoutMs,
        label: args.label,
        settled: false,
        timer: null,
        resolve,
        reject,
      };

      if (args.deadlockTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.handleDeadlockTimeout(args.key, waiter);
        }, args.deadlockTimeoutMs);
        waiter.timer.unref?.();
      }

      state.queue.push(waiter);
      this.grantNext(args.key);
    });
  }

  private clearWaiterTimer(waiter: Waiter): void {
    if (!waiter.timer) return;
    clearTimeout(waiter.timer);
    waiter.timer = null;
  }

  private removeWaiterFromQueue(key: string, waiter: Waiter): {
    holderLabel: string | null;
    heldMs: number | null;
    queueDepth: number;
  } {
    const state = this.states.get(key);
    if (!state) {
      return { holderLabel: null, heldMs: null, queueDepth: 0 };
    }

    const index = state.queue.indexOf(waiter);
    if (index >= 0) {
      state.queue.splice(index, 1);
    }

    return {
      holderLabel: state.ownerLabel,
      heldMs: state.ownerAcquiredAt === null ? null : Math.max(0, Date.now() - state.ownerAcquiredAt),
      queueDepth: state.queue.length,
    };
  }

  private handleDeadlockTimeout(key: string, waiter: Waiter): void {
    if (waiter.settled) return;
    waiter.settled = true;
    this.clearWaiterTimer(waiter);

    const timeoutState = this.removeWaiterFromQueue(key, waiter);
    const waitedMs = Math.max(0, Date.now() - waiter.enqueuedAt);

    // Reject the waiter BEFORE emitting telemetry: liveness must not depend on
    // observability. A telemetry throw must never strand the waiter's promise
    // (and emitDeadlockBreadcrumb is itself no-throw by construction).
    waiter.reject(new SessionMutexDeadlockError({
      key,
      waitedMs,
      deadlockTimeoutMs: waiter.deadlockTimeoutMs,
      label: waiter.label,
    }));

    this.emitDeadlockBreadcrumb({
      key,
      waitedMs,
      deadlockTimeoutMs: waiter.deadlockTimeoutMs,
      label: waiter.label,
      holderLabel: timeoutState.holderLabel,
      heldMs: timeoutState.heldMs,
      queueDepth: timeoutState.queueDepth,
    });

    // Integrity-first timeout handling: fail only this waiter. The holder keeps
    // ownership until its fn settles and release() advances the queue.
  }

  private grantNext(key: string): void {
    const state = this.states.get(key);
    if (!state || state.locked) return;

    while (state.queue.length > 0) {
      const waiter = state.queue.shift();
      if (!waiter || waiter.settled) continue;

      waiter.settled = true;
      this.clearWaiterTimer(waiter);

      state.locked = true;
      state.nextToken += 1;
      state.ownerToken = state.nextToken;
      state.ownerLabel = waiter.label ?? null;
      state.ownerAcquiredAt = Date.now();
      waiter.resolve(state.ownerToken);
      return;
    }

    state.ownerLabel = null;
    state.ownerAcquiredAt = null;
    this.states.delete(key);
  }

  private release(key: string, token: number): void {
    const state = this.states.get(key);
    if (!state) return;

    // Stale or duplicated release — ignore.
    if (state.ownerToken !== token) return;

    state.locked = false;
    state.ownerToken = null;
    state.ownerLabel = null;
    state.ownerAcquiredAt = null;
    this.grantNext(key);
  }

  // Telemetry emit is best-effort and MUST NOT throw — the mutex's liveness
  // (release / waiter rejection) cannot depend on observability succeeding.
  private emitContentionBreadcrumb(args: { key: string; waitedMs: number; label?: string }): void {
    try {
      const data: Record<string, unknown> = {
        kind: 'session-mutex-contention',
        reason: 'session-mutex-contention',
        sessionIdHash: hashForBreadcrumb(args.key),
        waitedMs: args.waitedMs,
      };
      if (args.label) data.label = args.label;

      recordSessionMutexContinuityBreadcrumb({
        level: 'warning',
        message: 'session-mutex-contention',
        data,
      });
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'sessionMutex.emitContentionBreadcrumb',
        reason: 'mutex telemetry is best-effort and must never break lock liveness',
      });
    }
  }

  private emitDeadlockBreadcrumb(args: {
    key: string;
    waitedMs: number;
    deadlockTimeoutMs: number;
    label?: string;
    holderLabel: string | null;
    heldMs: number | null;
    queueDepth: number;
  }): void {
    // Best-effort, no-throw (see emitContentionBreadcrumb).
    try {
      const sessionIdHash = hashForBreadcrumb(args.key);
      const data: Record<string, unknown> = {
        kind: 'session-mutex-deadlock',
        reason: 'session-mutex-deadlock',
        sessionIdHash,
        waitedMs: args.waitedMs,
        holderLabel: args.holderLabel,
        heldMs: args.heldMs,
        queueDepth: args.queueDepth,
      };
      if (args.label) data.label = args.label;

      recordSessionMutexContinuityBreadcrumb({
        level: 'error',
        message: 'session-mutex-deadlock',
        data,
      });

      getErrorReporter().captureMessage('Session mutex deadlock detected', {
        level: 'error',
        tags: {
          continuity_event: 'continuity-state:session-mutex-deadlock',
        },
        extra: {
          sessionIdHash,
          waitedMs: args.waitedMs,
          deadlockTimeoutMs: args.deadlockTimeoutMs,
          label: args.label,
          holderLabel: args.holderLabel,
          heldMs: args.heldMs,
          queueDepth: args.queueDepth,
        },
      });
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'sessionMutex.emitDeadlockBreadcrumb',
        reason: 'mutex telemetry is best-effort and must never break lock liveness',
      });
    }
  }
}

let sessionMutexSingleton: SessionMutex | null = null;

export function getSessionMutex(): SessionMutex {
  if (!sessionMutexSingleton) {
    sessionMutexSingleton = new SessionMutexImpl();
  }
  return sessionMutexSingleton;
}

export function resetSessionMutexForTests(): void {
  sessionMutexSingleton = null;
}
