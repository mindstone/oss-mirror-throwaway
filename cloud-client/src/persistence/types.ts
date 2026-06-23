// cloud-client/src/persistence/types.ts

/**
 * Platform-specific persistence adapter for local cache storage.
 *
 * Mobile provides an MMKV-backed implementation; web could use localStorage.
 * All methods are async (string-based, matching the AsyncStorage API contract)
 * so platform adapters can wrap both sync and async backends uniformly.
 */
export interface PersistenceAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;

  /**
   * Optional: return all stored keys. Used by `clearKeysForPrefix()` to enumerate
   * keys for bulk removal (e.g. on unpair). If not provided, the registry falls
   * back to in-memory key tracking.
   */
  getAllKeys?(): Promise<string[]>;
}
