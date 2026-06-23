/**
 * Canonical in-memory store for tests.
 *
 * Satisfies the `KeyValueStore<T>` interface from `@core/store`.
 * Used by both `vitest.setup.ts` (global setup) and `testHelpers.ts`
 * (post-resetModules re-initialization).
 *
 * Single source of truth — do NOT duplicate this class elsewhere.
 */
export class TestMemoryStore<T extends Record<string, unknown>> {
  private data: T;
  private readonly defaults: T;
  constructor(options?: { defaults?: T; name?: string }) {
    this.defaults = options?.defaults ?? {} as T;
    this.data = structuredClone(this.defaults);
  }
  get store(): T { return this.data; }
  set store(value: T) { this.data = value; }
  get<K extends keyof T>(key: K, defaultValue?: T[K]): T[K] | undefined {
    const val = this.data[key];
    return val !== undefined ? val : defaultValue;
  }
  set<K extends keyof T>(keyOrObj: K | Partial<T>, value?: T[K]): void {
    if (typeof keyOrObj === 'string') {
      (this.data as Record<string, unknown>)[keyOrObj] = value;
    } else {
      Object.assign(this.data, keyOrObj);
    }
  }
  has(key: string): boolean { return key in this.data; }
  delete(key: string): void { delete (this.data as Record<string, unknown>)[key]; }
  clear(): void { this.data = structuredClone(this.defaults); }
  get path(): string { return '/tmp/test-stores/config.json'; }
  onDidChange(_key: keyof T, _callback: () => void): () => void { return () => {}; }
  onDidAnyChange(_callback: () => void): () => void { return () => {}; }
  reload(): void { /* no-op in tests */ }
}
