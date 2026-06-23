/**
 * permissionGrantTracker — bridges grant events from the extension SW back
 * to in-flight `httpRelay` dispatches that just received `INJECTION_REFUSED`.
 *
 * Why this exists
 *
 *   When the agent calls a write capability (fill_form, click_element, …)
 *   on a brand-new origin, the content script can't be injected, the bridge
 *   returns `INJECTION_REFUSED`, and the agent's tool call fails. The user
 *   then opens the popup and clicks Allow — but historically that grant
 *   never reached Rebel, so the user had to manually re-prompt and the
 *   conversation looked stuck "read-only".
 *
 *   This tracker closes that loop. The wsServer routes `event` frames with
 *   `event: 'permission-granted'` to {@link recordGrant}. Inside `httpRelay`
 *   the INJECTION_REFUSED branch calls {@link awaitGrant} for the affected
 *   origin and, if a grant arrives within the timeout, retries the same
 *   command exactly once. The agent's MCP tool call never knows it took an
 *   extra few seconds — the dispatch promise just resolves later.
 *
 * Design points
 *
 *   - **In-memory only**, single-process. Bridge restart wipes state. That's
 *     fine: any in-flight HTTP request is gone too.
 *   - **Bounded memory** via a small ring of recent grants. Default 32 keeps
 *     memory ≤ a few KB even under abusive grant bursts.
 *   - **Recency window** lets `awaitGrant` succeed for a grant that landed
 *     a moment *before* the call (default 5s). This avoids a race where the
 *     SW posts the event microseconds before the relay decides to wait.
 *   - **Origin matching is exact-string.** The grant card asks for a
 *     specific origin and the dispatch's `INJECTION_REFUSED` details carry
 *     the same origin string from `injectionRefused()` in serviceWorker.ts.
 *     No wildcard logic.
 *   - **Broadcast semantics.** Permissions are origin-wide, so a single
 *     grant satisfies every in-flight waiter for that origin. We do NOT
 *     consume-once.
 */

import type { Logger } from 'pino';

export interface PermissionGrant {
  origin: string;
  /** ms-epoch when the grant landed in the SW. */
  at: number;
}

export interface AwaitGrantOptions {
  origin: string;
  /** Max wait in ms. */
  timeoutMs: number;
  /**
   * Optional abort signal. When fired, `awaitGrant` resolves `false`
   * promptly and removes the waiter.
   */
  signal?: AbortSignal;
}

export interface PermissionGrantTrackerOptions {
  /**
   * How recent a grant has to be to "count" for `awaitGrant` calls that
   * arrive *after* the grant. Default 5_000 ms.
   */
  recencyMs?: number;
  /** Bound on retained grants. Default 32. */
  maxRecentGrants?: number;
  /** Clock for tests. */
  now?: () => number;
  /** Optional logger. */
  logger?: Logger;
}

interface Waiter {
  origin: string;
  resolve: (granted: boolean) => void;
  timer: NodeJS.Timeout;
  abortHandler?: () => void;
  signal?: AbortSignal;
}

export class PermissionGrantTracker {
  private readonly recencyMs: number;
  private readonly maxRecentGrants: number;
  private readonly now: () => number;
  private readonly logger: Logger | undefined;
  /** Ring of recent grants. Newest at the end. */
  private readonly recentGrants: PermissionGrant[] = [];
  private readonly waiters = new Set<Waiter>();

  constructor(options: PermissionGrantTrackerOptions = {}) {
    this.recencyMs = options.recencyMs ?? 5_000;
    this.maxRecentGrants = options.maxRecentGrants ?? 32;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
  }

  /**
   * Record an incoming `permission-granted` event from the SW. Wakes every
   * waiter currently awaiting on this origin and adds the grant to the
   * recency ring.
   */
  recordGrant(grant: PermissionGrant): void {
    const now = this.now();
    const boundedGrant = { ...grant, at: Math.min(grant.at, now) };
    this.recentGrants.push(boundedGrant);
    if (this.recentGrants.length > this.maxRecentGrants) {
      this.recentGrants.shift();
    }
    this.logger?.info(
      { origin: redactOriginPort(boundedGrant.origin), at: boundedGrant.at, waiters: this.waiters.size },
      'Permission grant recorded',
    );
    for (const waiter of [...this.waiters]) {
      if (waiter.origin === boundedGrant.origin) {
        this.settle(waiter, true);
      }
    }
  }

  /**
   * Await a grant for `origin`. Resolves `true` if a grant arrives within
   * `timeoutMs` OR if a recent grant landed within `recencyMs` before the
   * call. Resolves `false` on timeout / abort / no-grant.
   */
  awaitGrant({ origin, timeoutMs, signal }: AwaitGrantOptions): Promise<boolean> {
    if (signal?.aborted) {
      return Promise.resolve(false);
    }

    // Fast path: a grant for this origin landed in the recency window. The
    // SW may have posted permission-granted before the relay decided to
    // wait — short of cross-thread atomicity, this is the simplest fix.
    const cutoff = this.now() - this.recencyMs;
    const recent = this.recentGrants.find(
      (g) => g.origin === origin && g.at >= cutoff,
    );
    if (recent) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        origin,
        resolve,
        timer: setTimeout(() => this.settle(waiter, false), timeoutMs),
      };
      if (signal) {
        waiter.signal = signal;
        waiter.abortHandler = () => this.settle(waiter, false);
        signal.addEventListener('abort', waiter.abortHandler, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  /** Test-only / dispose hook: drain all waiters as `false`. */
  dispose(): void {
    for (const waiter of [...this.waiters]) {
      this.settle(waiter, false);
    }
    this.recentGrants.length = 0;
  }

  /** For tests: return current waiter count. */
  pendingWaiterCount(): number {
    return this.waiters.size;
  }

  private settle(waiter: Waiter, granted: boolean): void {
    if (!this.waiters.delete(waiter)) {
      return;
    }
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abortHandler) {
      waiter.signal.removeEventListener('abort', waiter.abortHandler);
    }
    waiter.resolve(granted);
  }
}

/**
 * Strip path/query from origin strings for log redaction. Matches the
 * sentinel-less behavior of `redactOrigin` in `@shared/utils/sentryRedaction`
 * but kept inline so the tracker has no extra runtime dep.
 */
function redactOriginPort(origin: string): string {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '<malformed-origin>';
  }
}
