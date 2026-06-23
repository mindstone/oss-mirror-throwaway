import { createScopedLogger } from '@core/logger';
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';

const log = createScopedLogger({ service: 'sessionTombstoneStore' });

export type SessionDeletedBy = 'desktop' | 'mobile' | 'cloud';

export interface SessionTombstone {
  sessionId: string;
  deletedAt: number;
  deletedBy: SessionDeletedBy;
  ttlExpiresAt: number;
}

type SessionTombstoneStoreShape = {
  tombstones: SessionTombstone[];
};

interface SessionTombstoneStoreOptions {
  ttlMs?: number;
  cleanupIntervalMs?: number;
  now?: () => number;
  store?: KeyValueStore<SessionTombstoneStoreShape>;
}

const STORE_NAME = 'session-tombstones';
const TOMBSTONES_KEY = 'tombstones';
const DEFAULT_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let _store: KeyValueStore<SessionTombstoneStoreShape> | null = null;
function getStore(): KeyValueStore<SessionTombstoneStoreShape> {
  _store ??= createStore<SessionTombstoneStoreShape>({
    name: STORE_NAME,
    defaults: {
      tombstones: [],
    },
  });
  return _store;
}

function isValidDeletedBy(value: unknown): value is SessionDeletedBy {
  return value === 'desktop' || value === 'mobile' || value === 'cloud';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseTombstone(value: unknown): SessionTombstone | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) return null;
  if (!isFiniteNumber(record.deletedAt)) return null;
  if (!isValidDeletedBy(record.deletedBy)) return null;
  if (!isFiniteNumber(record.ttlExpiresAt)) return null;
  return {
    sessionId: record.sessionId,
    deletedAt: record.deletedAt,
    deletedBy: record.deletedBy,
    ttlExpiresAt: record.ttlExpiresAt,
  };
}

export class SessionTombstoneStore {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly store: KeyValueStore<SessionTombstoneStoreShape>;
  private readonly tombstones = new Map<string, SessionTombstone>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(options: SessionTombstoneStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.store = options.store ?? getStore();

    this.loadFromStore();
    this.cleanupTimer = setInterval(() => {
      const removed = this.removeExpiredTombstones();
      if (removed > 0) {
        log.info({ removed }, 'Removed expired session tombstones');
      }
    }, options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  addTombstone(sessionId: string, deletedBy: SessionDeletedBy, deletedAt = this.now()): SessionTombstone {
    const existing = this.tombstones.get(sessionId);
    if (existing && existing.deletedAt >= deletedAt && existing.ttlExpiresAt > this.now()) {
      return existing;
    }

    const tombstone: SessionTombstone = {
      sessionId,
      deletedAt,
      deletedBy,
      ttlExpiresAt: deletedAt + this.ttlMs,
    };
    this.tombstones.set(sessionId, tombstone);
    this.persist();
    return tombstone;
  }

  getTombstone(sessionId: string): SessionTombstone | null {
    const tombstone = this.tombstones.get(sessionId);
    if (!tombstone) return null;
    if (tombstone.ttlExpiresAt <= this.now()) {
      this.tombstones.delete(sessionId);
      this.persist();
      return null;
    }
    return tombstone;
  }

  hasTombstone(sessionId: string): boolean {
    return this.getTombstone(sessionId) !== null;
  }

  listTombstones(since?: number): SessionTombstone[] {
    this.removeExpiredTombstones();
    const threshold = isFiniteNumber(since) ? since : undefined;
    const entries = Array.from(this.tombstones.values())
      .filter((entry) => threshold === undefined || entry.deletedAt > threshold)
      .sort((a, b) => a.deletedAt - b.deletedAt);
    return entries.map((entry) => ({ ...entry }));
  }

  removeExpiredTombstones(): number {
    const now = this.now();
    let removed = 0;
    for (const [sessionId, tombstone] of this.tombstones) {
      if (tombstone.ttlExpiresAt <= now) {
        this.tombstones.delete(sessionId);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.persist();
    }
    return removed;
  }

  clearAll(): void {
    if (this.tombstones.size === 0) return;
    this.tombstones.clear();
    this.persist();
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
  }

  private loadFromStore(): void {
    const raw = this.store.get(TOMBSTONES_KEY, []);
    if (!Array.isArray(raw)) return;

    let skipped = 0;
    for (const value of raw) {
      const parsed = parseTombstone(value);
      if (!parsed) {
        skipped += 1;
        continue;
      }
      const existing = this.tombstones.get(parsed.sessionId);
      if (!existing || parsed.deletedAt >= existing.deletedAt) {
        this.tombstones.set(parsed.sessionId, parsed);
      }
    }

    if (skipped > 0) {
      log.warn({ skipped }, 'Skipped invalid tombstones while loading');
    }

    this.removeExpiredTombstones();
  }

  private persist(): void {
    const tombstones = Array.from(this.tombstones.values()).sort((a, b) => a.deletedAt - b.deletedAt);
    this.store.set(TOMBSTONES_KEY, tombstones);
  }
}

let _singleton: SessionTombstoneStore | null = null;

export function createSessionTombstoneStore(options: SessionTombstoneStoreOptions = {}): SessionTombstoneStore {
  return new SessionTombstoneStore(options);
}

export function getSessionTombstoneStore(): SessionTombstoneStore {
  _singleton ??= createSessionTombstoneStore();
  return _singleton;
}

export function resetSessionTombstoneStoreForTests(): void {
  if (_singleton) {
    _singleton.dispose();
    _singleton.clearAll();
    _singleton = null;
  }
  if (_store) {
    _store.clear();
    _store = null;
  }
}
