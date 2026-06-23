import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'codex-auth' });

export interface CodexAuthProvider {
  isConnected(): boolean;
  getAccessToken(): Promise<string | null>;
  getAccountId(): string | null;
  forceRefreshToken(): Promise<string | null>;
  getStatus(): { connected: boolean; accountEmail?: string };
}

/** Codex Responses API endpoint (constant across all surfaces) */
export const CODEX_ENDPOINT_URL = 'https://chatgpt.com/backend-api/codex/responses';

/** Null provider — Codex not available on this surface. */
export const NULL_CODEX_AUTH_PROVIDER: CodexAuthProvider = {
  isConnected: () => false,
  getAccessToken: async () => null,
  getAccountId: () => null,
  forceRefreshToken: async () => null,
  getStatus: () => ({ connected: false }),
};

let _provider: CodexAuthProvider | undefined;

export function setCodexAuthProvider(provider: CodexAuthProvider): void {
  _provider = provider;
  log.info({ connected: provider.isConnected() }, 'Codex auth provider registered');
}

export function getCodexAuthProvider(): CodexAuthProvider {
  if (!_provider) {
    throw new Error('CodexAuthProvider not registered — call setCodexAuthProvider() during bootstrap');
  }
  return _provider;
}
