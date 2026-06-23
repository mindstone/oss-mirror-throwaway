/**
 * SecureTokenStore — boundary interface for token persistence.
 *
 * Token-storage modules pass their backing store + key and this boundary
 * handles encryption/decryption behavior per surface.
 */

export interface SecureTokenBackingStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  has(key: string): boolean;
}

export const SECURE_TOKEN_CORRUPT_SIDECAR_SUFFIX = '.corrupt.latest';

export function isSecureTokenReservedSidecarKey(key: string): boolean {
  return key.endsWith(SECURE_TOKEN_CORRUPT_SIDECAR_SUFFIX);
}

export function assertSecureTokenLiveKey(key: string): void {
  if (isSecureTokenReservedSidecarKey(key)) {
    throw new Error(
      `SecureTokenStore live key "${key}" is reserved for corruption sidecars (${SECURE_TOKEN_CORRUPT_SIDECAR_SUFFIX})`,
    );
  }
}

export function getSecureTokenCorruptSidecarKey(key: string): string {
  assertSecureTokenLiveKey(key);
  return `${key}${SECURE_TOKEN_CORRUPT_SIDECAR_SUFFIX}`;
}

export interface SecureTokenReadOptions {
  store: SecureTokenBackingStore;
  key: string;
  kind: string;
  namespace: string;
  validate: (value: string) => boolean;
  onDestructiveRead?: (signal: SecureTokenDestructiveReadSignal) => void;
}

export type SecureTokenDestructiveReadKind = 'corrupt' | 'unavailable_encrypted';

export interface SecureTokenDestructiveReadSignal {
  kind: SecureTokenDestructiveReadKind;
  namespace: string;
  key: string;
  sidecarKey?: string;
}

export interface SecureTokenWriteOptions {
  store: SecureTokenBackingStore;
  key: string;
  value: string;
  namespace: string;
}

export interface SecureTokenDeleteOptions {
  store: SecureTokenBackingStore;
  key: string;
  namespace: string;
}

export interface SecureTokenHasOptions {
  store: SecureTokenBackingStore;
  key: string;
  namespace: string;
}

export interface SecureTokenStore {
  read(options: SecureTokenReadOptions): string | null;
  write(options: SecureTokenWriteOptions): void;
  delete(options: SecureTokenDeleteOptions): void;
  has(options: SecureTokenHasOptions): boolean;
  isEncryptionAvailable(): boolean;
}

export type SecureTokenStoreFactory = () => SecureTokenStore;

let _factory: SecureTokenStoreFactory | undefined;
let _instance: SecureTokenStore | undefined;

export function setSecureTokenStoreFactory(factory: SecureTokenStoreFactory): void {
  _factory = factory;
  _instance = undefined;
}

export function getSecureTokenStore(): SecureTokenStore {
  if (_instance) return _instance;
  if (!_factory) {
    throw new Error(
      'SecureTokenStore not initialized. Call setSecureTokenStoreFactory() before token storage access.',
    );
  }
  _instance = _factory();
  return _instance;
}
