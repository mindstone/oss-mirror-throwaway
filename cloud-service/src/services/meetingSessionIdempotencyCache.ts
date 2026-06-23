const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

export interface MeetingSessionIdempotencyRecord {
  bearerTokenHash: string;
  idempotencyKey: string;
  cloudSessionId: string;
  companionSessionId: string | null;
  createdAt: number;
  expiresAt: number;
}

interface MeetingSessionIdempotencyCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export type MeetingSessionReplayResolution =
  | { kind: 'miss' }
  | { kind: 'hit'; record: MeetingSessionIdempotencyRecord; reason: 'same-companion' | 'request-missing-companion' | 'cached-missing-companion' }
  | { kind: 'conflict'; record: MeetingSessionIdempotencyRecord }
  | { kind: 'backfill'; record: MeetingSessionIdempotencyRecord };

export class MeetingSessionIdempotencyCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly records = new Map<string, MeetingSessionIdempotencyRecord>();
  private readonly inFlightByKey = new Map<string, Promise<unknown>>();

  public constructor(options: MeetingSessionIdempotencyCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  public async withAtomicKey<T>(
    args: { bearerTokenHash: string; idempotencyKey: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    const compositeKey = this.buildCompositeKey(args.bearerTokenHash, args.idempotencyKey);
    const existing = this.inFlightByKey.get(compositeKey);
    if (existing) {
      return existing as Promise<T>;
    }

    let inFlightPromise: Promise<T>;
    inFlightPromise = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.inFlightByKey.get(compositeKey) === inFlightPromise) {
          this.inFlightByKey.delete(compositeKey);
        }
      });
    this.inFlightByKey.set(compositeKey, inFlightPromise as Promise<unknown>);
    return inFlightPromise;
  }

  public evaluateReplay(args: {
    bearerTokenHash: string;
    idempotencyKey: string;
    companionSessionId: string | null;
  }): MeetingSessionReplayResolution {
    const record = this.getRecord(args.bearerTokenHash, args.idempotencyKey);
    if (!record) return { kind: 'miss' };

    const requestedCompanionSessionId = args.companionSessionId;

    if (record.companionSessionId === null && requestedCompanionSessionId) {
      return { kind: 'backfill', record };
    }

    if (record.companionSessionId && requestedCompanionSessionId && record.companionSessionId !== requestedCompanionSessionId) {
      return { kind: 'conflict', record };
    }

    if (record.companionSessionId && !requestedCompanionSessionId) {
      return { kind: 'hit', record, reason: 'request-missing-companion' };
    }

    if (record.companionSessionId === null) {
      return { kind: 'hit', record, reason: 'cached-missing-companion' };
    }

    return { kind: 'hit', record, reason: 'same-companion' };
  }

  public upsert(args: {
    bearerTokenHash: string;
    idempotencyKey: string;
    cloudSessionId: string;
    companionSessionId: string | null;
  }): MeetingSessionIdempotencyRecord {
    const now = this.now();
    const record: MeetingSessionIdempotencyRecord = {
      bearerTokenHash: args.bearerTokenHash,
      idempotencyKey: args.idempotencyKey,
      cloudSessionId: args.cloudSessionId,
      companionSessionId: args.companionSessionId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.setRecord(record);
    return { ...record };
  }

  public backfillCompanionSessionId(args: {
    bearerTokenHash: string;
    idempotencyKey: string;
    companionSessionId: string;
  }): MeetingSessionIdempotencyRecord | null {
    const compositeKey = this.buildCompositeKey(args.bearerTokenHash, args.idempotencyKey);
    const existing = this.getRecord(args.bearerTokenHash, args.idempotencyKey);
    if (!existing) return null;

    if (existing.companionSessionId === args.companionSessionId) {
      return existing;
    }

    if (existing.companionSessionId !== null) {
      return null;
    }

    const updated: MeetingSessionIdempotencyRecord = {
      ...existing,
      companionSessionId: args.companionSessionId,
      expiresAt: this.now() + this.ttlMs,
    };
    this.records.delete(compositeKey);
    this.records.set(compositeKey, updated);
    return { ...updated };
  }

  public sizeForTesting(): number {
    return this.records.size;
  }

  public clearForTesting(): void {
    this.records.clear();
    this.inFlightByKey.clear();
  }

  private getRecord(bearerTokenHash: string, idempotencyKey: string): MeetingSessionIdempotencyRecord | null {
    const compositeKey = this.buildCompositeKey(bearerTokenHash, idempotencyKey);
    const existing = this.records.get(compositeKey);
    if (!existing) return null;

    if (existing.expiresAt <= this.now()) {
      this.records.delete(compositeKey);
      return null;
    }

    this.records.delete(compositeKey);
    this.records.set(compositeKey, existing);
    return { ...existing };
  }

  private setRecord(record: MeetingSessionIdempotencyRecord): void {
    const compositeKey = this.buildCompositeKey(record.bearerTokenHash, record.idempotencyKey);
    this.records.delete(compositeKey);
    this.records.set(compositeKey, record);
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    while (this.records.size > this.maxEntries) {
      const oldestKey = this.records.keys().next().value;
      if (!oldestKey) break;
      this.records.delete(oldestKey);
    }
  }

  private buildCompositeKey(bearerTokenHash: string, idempotencyKey: string): string {
    return `${bearerTokenHash}\u0000${idempotencyKey}`;
  }
}
