/**
 * KeyValueStore — platform-agnostic persistent store interface.
 *
 * Replaces direct `electron-store` usage. Electron impl wraps electron-store;
 * cloud impl can use a JSON file on disk.
 */

export interface KeyValueStore<T extends Record<string, unknown> = Record<string, unknown>> {
  get<K extends keyof T & string>(key: K): T[K] | undefined;
  get<K extends keyof T & string>(key: K, defaultValue: T[K]): T[K];
  set<K extends keyof T & string>(key: K, value: T[K]): void;
  set(values: Partial<T>): void;
  has(key: string): boolean;
  delete(key: string): void;
  clear(): void;
  store: T;
  readonly path: string;
  reload?(): void;
  onDidChange?<K extends keyof T & string>(
    key: K,
    callback: (newValue: T[K] | undefined, oldValue: T[K] | undefined) => void,
  ): () => void;
  onDidAnyChange?(
    callback: (newValue: T | undefined, oldValue: T | undefined) => void,
  ): () => void;
}
