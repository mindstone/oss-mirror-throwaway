import type { TokenSyncSignal } from '@core/setTokenSyncTransport';

export type OAuthProvider = 'google' | 'slack' | 'hubspot' | 'microsoft';

export type EnsureFreshishResult =
  | { ok: true; source: 'local' | 'peer' | 'unwired' }
  | { ok: false; error: string };

export interface TokenSyncCoordinator {
  ensureFreshish(args: {
    provider: string;
    accountKey: string;
    deadlineMs: number;
  }): Promise<EnsureFreshishResult>;
  onLocalWrite(args: {
    provider: string;
    accountKey: string;
    relativePath: string;
    expiryEpochMs: number;
    mtimeMs: number;
  }): Promise<void>;
  onPeerSignal(signal: TokenSyncSignal): Promise<void>;
  onPeerTombstone(args: {
    provider: string;
    accountKey: string;
    relativePath: string;
    tombstoneEpochMs: number;
  }): Promise<void>;
  getStatus(): Promise<Record<string, unknown>>;
}

export const NULL_TOKEN_SYNC_COORDINATOR: TokenSyncCoordinator = {
  ensureFreshish: async () => ({ ok: true, source: 'unwired' }),
  onLocalWrite: async () => {},
  onPeerSignal: async () => {},
  onPeerTombstone: async () => {},
  getStatus: async () => ({ unwired: true }),
};

let _tokenSyncCoordinator: TokenSyncCoordinator = NULL_TOKEN_SYNC_COORDINATOR;

export function setTokenSyncCoordinator(coordinator: TokenSyncCoordinator): void {
  _tokenSyncCoordinator = coordinator;
}

export function getTokenSyncCoordinator(): TokenSyncCoordinator {
  return _tokenSyncCoordinator;
}