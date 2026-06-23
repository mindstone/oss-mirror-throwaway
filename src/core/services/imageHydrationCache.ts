import { Buffer } from 'node:buffer';

export type CacheKey = `${string}::${string}::${'orig' | 'downscaled'}::${string}`; // sessionId::assetId::variant::providerKey
export type CacheEntry = { bytes: Buffer; mimeType: string; byteSize: number };

/**
 * A per-turn LRU cache for image hydration to avoid repeated disk reads
 * when an image reference is used multiple times in the same turn.
 * 
 * Cleared at turn boundary to avoid memory leaks.
 */
export class TurnScopedHydrationCache {
  private cache = new Map<CacheKey, CacheEntry>(); // LRU via Map insertion-order
  private maxBytes: number = 100 * 1024 * 1024; // 100MB per-turn cap
  private currentBytes = 0;

  get(key: CacheKey): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // LRU behavior: delete and re-insert to mark as most-recently-used
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry;
  }

  set(key: CacheKey, entry: CacheEntry): void {
    const existing = this.cache.get(key);
    if (existing) {
      this.currentBytes -= existing.byteSize;
      this.cache.delete(key);
    }

    this.cache.set(key, entry);
    this.currentBytes += entry.byteSize;

    // Evict if over limit (Map iteration order is insertion order, oldest first)
    for (const [oldKey, oldEntry] of this.cache) {
      if (this.currentBytes <= this.maxBytes) break;
      this.cache.delete(oldKey);
      this.currentBytes -= oldEntry.byteSize;
    }
  }

  clear(): void {
    this.cache.clear();
    this.currentBytes = 0;
  }

  size(): { count: number; bytes: number } {
    return { count: this.cache.size, bytes: this.currentBytes };
  }
}
