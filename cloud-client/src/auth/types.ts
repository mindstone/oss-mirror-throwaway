// cloud-client/src/auth/types.ts

/** Platform-specific token persistence adapter. */
export interface TokenStorage {
  getToken(): Promise<{ cloudUrl: string; token: string } | null>;
  setToken(cloudUrl: string, token: string): Promise<void>;
  clearToken(): Promise<void>;
  /**
   * Optional stable per-device client id used for server-side device scoping
   * (e.g., per-device rate limits and observability).
   */
  getClientId?(): Promise<string | null>;
  setClientId?(clientId: string): Promise<void>;
}
