export type TurnIdempotencyStatus = 'in_flight' | 'persisted' | 'errored';
export type TurnIdempotencyOutcome = 'result' | 'error';
export type TurnIdempotencyOwnership = 'available' | 'owned' | 'collision';

export interface TurnIdempotencyEntry {
  clientTurnId: string;
  turnId: string;
  sessionId: string;
  status: TurnIdempotencyStatus;
  persistedAt?: number;
  outcome?: TurnIdempotencyOutcome;
}

interface StoredTurnIdempotencyEntry extends TurnIdempotencyEntry {
  updatedAt: number;
}

interface TurnIdempotencyIndexOptions {
  ttlMs?: number;
  cleanupIntervalMs?: number;
  now?: () => number;
}

export interface TurnIdempotencyLookupResult {
  ownership: TurnIdempotencyOwnership;
  entry?: TurnIdempotencyEntry;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export class TurnIdempotencyIndex {
  private readonly entries = new Map<string, StoredTurnIdempotencyEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(options: TurnIdempotencyIndexOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    const cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  get(clientTurnId: string): TurnIdempotencyEntry | undefined {
    this.cleanupExpired();
    const entry = this.entries.get(clientTurnId);
    if (!entry) return undefined;
    return this.toPublicEntry(entry);
  }

  getForSession(clientTurnId: string, sessionId: string): TurnIdempotencyLookupResult {
    const entry = this.get(clientTurnId);
    if (!entry) {
      return { ownership: 'available' };
    }
    if (entry.sessionId === sessionId || entry.sessionId.trim().length === 0) {
      return { ownership: 'owned', entry };
    }
    return { ownership: 'collision', entry };
  }

  markInFlight(clientTurnId: string, values: { turnId?: string; sessionId?: string } = {}): TurnIdempotencyEntry {
    const now = this.now();
    const existing = this.entries.get(clientTurnId);
    const next: StoredTurnIdempotencyEntry = {
      clientTurnId,
      turnId: values.turnId ?? existing?.turnId ?? '',
      sessionId: values.sessionId ?? existing?.sessionId ?? '',
      status: 'in_flight',
      persistedAt: undefined,
      outcome: undefined,
      updatedAt: now,
    };
    this.entries.set(clientTurnId, next);
    return this.toPublicEntry(next);
  }

  setTurnInfo(clientTurnId: string, values: { turnId: string; sessionId: string }): TurnIdempotencyEntry {
    const now = this.now();
    const existing = this.entries.get(clientTurnId);
    const next: StoredTurnIdempotencyEntry = {
      clientTurnId,
      turnId: values.turnId,
      sessionId: values.sessionId,
      status: existing?.status ?? 'in_flight',
      persistedAt: existing?.persistedAt,
      outcome: existing?.outcome,
      updatedAt: now,
    };
    this.entries.set(clientTurnId, next);
    return this.toPublicEntry(next);
  }

  markPersisted(clientTurnId: string, values: {
    turnId: string;
    sessionId: string;
    outcome: TurnIdempotencyOutcome;
  }): TurnIdempotencyEntry {
    const now = this.now();
    const next: StoredTurnIdempotencyEntry = {
      clientTurnId,
      turnId: values.turnId,
      sessionId: values.sessionId,
      status: 'persisted',
      persistedAt: now,
      outcome: values.outcome,
      updatedAt: now,
    };
    this.entries.set(clientTurnId, next);
    return this.toPublicEntry(next);
  }

  markErrored(clientTurnId: string, values: {
    turnId?: string;
    sessionId?: string;
    outcome?: TurnIdempotencyOutcome;
  } = {}): TurnIdempotencyEntry {
    const now = this.now();
    const existing = this.entries.get(clientTurnId);
    const next: StoredTurnIdempotencyEntry = {
      clientTurnId,
      turnId: values.turnId ?? existing?.turnId ?? '',
      sessionId: values.sessionId ?? existing?.sessionId ?? '',
      status: 'errored',
      persistedAt: existing?.persistedAt,
      outcome: values.outcome ?? existing?.outcome,
      updatedAt: now,
    };
    this.entries.set(clientTurnId, next);
    return this.toPublicEntry(next);
  }

  clear(clientTurnId: string): void {
    this.entries.delete(clientTurnId);
  }

  clearAll(): void {
    this.entries.clear();
  }

  size(): number {
    this.cleanupExpired();
    return this.entries.size;
  }

  cleanupExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, value] of this.entries.entries()) {
      if (now - value.updatedAt > this.ttlMs) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
  }

  private toPublicEntry(entry: StoredTurnIdempotencyEntry): TurnIdempotencyEntry {
    const { updatedAt: _updatedAt, ...publicEntry } = entry;
    return { ...publicEntry };
  }
}

const singleton = new TurnIdempotencyIndex();

export function getTurnIdempotencyIndex(): TurnIdempotencyIndex {
  return singleton;
}

export function resetTurnIdempotencyIndexForTests(): void {
  singleton.clearAll();
}
