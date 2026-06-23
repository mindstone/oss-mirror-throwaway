// cloud-client/src/auth/createAuthStore.ts

import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import * as cloudClient from '../cloudClient';
import type { TokenStorage } from './types';

// ── Stable per-device install id (`rebel_client_id`) ────────────────────────
// Single source of truth: both this auth store (server-side device scoping) and
// the mobile analytics singleton (RudderStack anonymousId) resolve the SAME id
// via `getOrCreateClientId`, so one device never fragments into two identities.
// Lives here (not a standalone module) so cloud-client takes no runtime dep on
// @shared/* (forbidden) — the best-effort catches follow this package's bare
// convention. Genuinely single-flight per storage instance (GPT F1): the prior
// write-then-re-read was NOT race-safe under a simultaneous double-miss (two
// callers could read empty, generate DIFFERENT ids, and each adopt its own); we
// memoise the in-flight resolution promise keyed by storage so concurrent
// first-launch callers converge on ONE id and generate runs at most once.

/** Generate a stable client id. Prefers crypto.randomUUID; falls back when absent. */
export function generateClientId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (typeof randomUuid === 'string' && randomUuid.length > 0) {
    return randomUuid;
  }
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const inFlightClientIdByStorage = new WeakMap<TokenStorage, Promise<string | undefined>>();

/**
 * Resolve the persisted install id, creating and persisting one if absent.
 * Single-flight per storage instance; best-effort throughout (a storage failure
 * degrades to an in-memory id rather than blocking boot). Returns `undefined`
 * only when the adapter cannot read ids at all (no `getClientId`). The in-flight
 * entry clears once settled, so later calls read storage afresh (storage stays
 * the source of truth; memoisation only collapses CONCURRENT misses).
 */
export async function getOrCreateClientId(
  storage: TokenStorage,
): Promise<string | undefined> {
  if (typeof storage.getClientId !== 'function') return undefined;

  const inFlight = inFlightClientIdByStorage.get(storage);
  if (inFlight) return inFlight;

  const resolution = resolveClientId(storage).finally(() => {
    inFlightClientIdByStorage.delete(storage);
  });
  inFlightClientIdByStorage.set(storage, resolution);
  return resolution;
}

/** Read-through resolution. Only ever invoked single-flight per storage instance. */
async function resolveClientId(storage: TokenStorage): Promise<string | undefined> {
  try {
    const existing = await storage.getClientId!();
    if (typeof existing === 'string' && existing.trim().length > 0) {
      return existing.trim();
    }
  } catch {
    // Best-effort only — continue with generation attempt.
  }

  const generated = generateClientId();
  if (typeof storage.setClientId === 'function') {
    try {
      await storage.setClientId(generated);
    } catch {
      // Best-effort persistence — keep in-memory usage even if write fails.
    }
  }
  return generated;
}

export interface AuthState {
  cloudUrl: string | null;
  token: string | null;
  isPaired: boolean;
  isValidating: boolean;
  error: string | null;
  /**
   * True once `loadCredentials()` has produced a definitive answer from
   * underlying storage (either credentials were returned, or the storage
   * confirmed no credentials are present). Stays false when the storage
   * read itself failed (e.g. transient iOS Keychain unavailability right
   * after an app update). Callers should treat `false` as "still
   * unknown — keep showing the splash" rather than "no credentials".
   */
  credentialsResolved: boolean;
  loadCredentials: () => Promise<void>;
  pair: (cloudUrl: string, token: string) => Promise<void>;
  unpair: () => Promise<void>;
  clearError: () => void;
}

type AuthStore = UseBoundStore<StoreApi<AuthState>>;

let _store: AuthStore | null = null;
let _storage: TokenStorage | null = null;

function getStore(): AuthStore {
  if (!_store) {
    throw new Error('Auth store not initialised. Call initAuthStore(storage) at app startup.');
  }
  return _store;
}

/**
 * Initialise the auth store with a platform-specific storage adapter.
 * Must be called once at app startup before any component renders.
 */
export function initAuthStore(storage: TokenStorage): AuthStore {
  _storage = storage;

  _store = create<AuthState>((set) => ({
    cloudUrl: null,
    token: null,
    isPaired: false,
    isValidating: false,
    error: null,
    credentialsResolved: false,

    loadCredentials: async () => {
      try {
        const creds = await _storage!.getToken();
        if (creds) {
          const clientId = await getOrCreateClientId(_storage!);
          cloudClient.configure({
            cloudUrl: creds.cloudUrl,
            token: creds.token,
            ...(clientId ? { clientId } : {}),
          });
          set({
            cloudUrl: creds.cloudUrl,
            token: creds.token,
            isPaired: true,
            credentialsResolved: true,
          });
        } else {
          // Storage was reachable and reported no credentials — definitive answer.
          set({ credentialsResolved: true });
        }
      } catch {
        // Storage unavailable (e.g. transient iOS Keychain after app update).
        // Leave credentialsResolved=false so callers keep the splash up rather
        // than misinterpreting the silent failure as "no credentials" and
        // dropping the user into the pairing flow. A retry on next app
        // foreground will produce a definitive answer.
      }
    },

    pair: async (cloudUrl: string, token: string) => {
      set({ isValidating: true, error: null });
      const normalizedUrl = cloudUrl.trim().replace(/\/+$/, '');

      try {
        const clientId = await getOrCreateClientId(_storage!);
        cloudClient.configure({
          cloudUrl: normalizedUrl,
          token: token.trim(),
          ...(clientId ? { clientId } : {}),
        });
        const health = await cloudClient.checkHealth();
        if (health.status !== 'ok') {
          throw new Error('Server reported unhealthy status');
        }
        await cloudClient.getSettings();
      } catch (err) {
        cloudClient.clearConfig();
        const message = err instanceof Error ? err.message : 'Connection failed';
        const isNetwork =
          message.includes('abort') || message.includes('timeout') || message.includes('Network');
        set({
          isValidating: false,
          error: isNetwork
            ? 'Server is waking up or unreachable. Give it a moment and try again.'
            : message,
        });
        return;
      }

      try {
        await _storage!.setToken(normalizedUrl, token.trim());
      } catch {
        // If storage fails, still mark as paired (in-memory only)
      }

      set({
        cloudUrl: normalizedUrl,
        token: token.trim(),
        isPaired: true,
        isValidating: false,
        error: null,
        credentialsResolved: true,
      });
    },

    unpair: async () => {
      cloudClient.clearConfig();
      try {
        await _storage!.clearToken();
      } catch {
        /* best-effort */
      }
      set({
        cloudUrl: null,
        token: null,
        isPaired: false,
        error: null,
        credentialsResolved: true,
      });
    },

    clearError: () => set({ error: null }),
  }));

  return _store;
}

/**
 * Access the auth store. Throws if `initAuthStore()` has not been called.
 *
 * Usage:
 *   As a React hook:   `const isPaired = useAuthStore(s => s.isPaired)`
 *   Static access:     `useAuthStore.getState().unpair()`
 *   Subscribe:         `useAuthStore.subscribe(listener)`
 */
export const useAuthStore: {
  (): AuthState;
  <T>(selector: (state: AuthState) => T): T;
  getState: () => AuthState;
  setState: (partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>)) => void;
  subscribe: (listener: (state: AuthState, prevState: AuthState) => void) => () => void;
} = Object.assign(
  function useAuthStore<T>(selector?: (state: AuthState) => T): T | AuthState {
    const store = getStore();
    if (selector) return store(selector);
    return store();
  },
  {
    getState: (): AuthState => getStore().getState(),
    setState: (partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>)) =>
      getStore().setState(partial),
    subscribe: (listener: (state: AuthState, prevState: AuthState) => void) =>
      getStore().subscribe(listener),
  },
) as never;
