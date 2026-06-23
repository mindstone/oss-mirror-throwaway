export interface TokenSyncSignal {
  provider: string;
  accountKey: string;
  expiryEpochMs: number;
  mtimeMs: number;
  surfaceWrote: 'desktop' | 'cloud';
}

export interface TokenMetadata {
  provider: string;
  accountKey: string;
  relativePath: string;
  expiryEpochMs: number;
  mtimeMs: number;
  surfaceWrote: 'desktop' | 'cloud';
}

export type PullMetadataResult =
  | { ok: true; metadata: TokenMetadata }
  | {
      ok: false;
      error: 'unwired' | 'not_found' | 'not_newer' | 'tombstoned' | 'malformed' | 'network' | 'auth';
    };

export type PullTokenResult =
  | {
      ok: true;
      content: Buffer;
      mtimeMs: number;
      expiryEpochMs: number;
      surfaceWrote: 'desktop' | 'cloud';
    }
  | {
      ok: false;
      error: 'unwired' | 'not_found' | 'not_newer' | 'tombstoned' | 'malformed' | 'network' | 'auth';
    };

export interface TokenSyncTransport {
  publishSignal(signal: TokenSyncSignal): Promise<void>;
  pullMetadata(args: { provider: string; accountKey: string }): Promise<PullMetadataResult>;
  pullToken(args: { provider: string; relativePath: string }): Promise<PullTokenResult>;
  pushTombstone(args: { provider: string; relativePath: string; tombstoneEpochMs: number }): Promise<void>;
}

export const NULL_TOKEN_SYNC_TRANSPORT: TokenSyncTransport = {
  publishSignal: async () => {},
  pullMetadata: async () => ({ ok: false, error: 'unwired' }),
  pullToken: async () => ({ ok: false, error: 'unwired' }),
  pushTombstone: async () => {},
};

let _tokenSyncTransport: TokenSyncTransport = NULL_TOKEN_SYNC_TRANSPORT;

export function setTokenSyncTransport(transport: TokenSyncTransport): void {
  _tokenSyncTransport = transport;
}

export function getTokenSyncTransport(): TokenSyncTransport {
  return _tokenSyncTransport;
}
