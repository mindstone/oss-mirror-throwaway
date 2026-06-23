import { Buffer } from 'node:buffer';

/**
 * LRU cache for hydrated content refs, keyed by `${sessionId}:${contentId}`.
 * Default size is 50 entries and default TTL is 5 minutes.
 */
export interface ContentHydrationCacheEntry {
  bytes: Buffer;
  mimeType: string;
}

type InternalEntry = {
  hydrated: ContentHydrationCacheEntry;
  expiresAt: number;
};

const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_TTL_MS = 5 * 60 * 1_000;

export interface ContentHydrationCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

function buildKey(sessionId: string, contentId: string): string {
  return `${sessionId}:${contentId}`;
}

export class ContentHydrationCache {
  private cache = new Map<string, InternalEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options?: ContentHydrationCacheOptions) {
    this.maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.ttlMs = Math.max(1, options?.ttlMs ?? DEFAULT_TTL_MS);
    this.now = options?.now ?? (() => Date.now());
  }

  get(sessionId: string, contentId: string): ContentHydrationCacheEntry | undefined {
    const key = buildKey(sessionId, contentId);
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return undefined;
    }

    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.hydrated;
  }

  set(sessionId: string, contentId: string, hydrated: ContentHydrationCacheEntry): void {
    const key = buildKey(sessionId, contentId);
    this.cache.delete(key);
    this.cache.set(key, {
      hydrated,
      expiresAt: this.now() + this.ttlMs,
    });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  clear(): void {
    this.cache.clear();
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  size(): number {
    return this.cache.size;
  }
}

/**
 * Backward-compatible alias used by provider clients. Stage B1b.
 */
export class TurnScopedContentHydrationCache extends ContentHydrationCache {}
