import { createScopedLogger } from '@core/logger';
import type {
  PullMetadataResult,
  PullTokenResult,
  TokenSyncSignal,
  TokenSyncTransport,
} from '@core/setTokenSyncTransport';
import { cloudEventChannel } from './cloudEventChannel';

const log = createScopedLogger({ service: 'desktopTokenSyncTransport' });

type CloudConnection = {
  cloudUrl: string;
  cloudToken: string;
};

type FetchLike = typeof fetch;
type PullError = Extract<PullMetadataResult, { ok: false }>['error'];

function buildRelayPath(provider: string, pathLike: string, suffix = ''): string {
  return `/api/auth/relay/${encodeURIComponent(provider)}/${encodeURIComponent(pathLike)}${suffix}`;
}

function normalizeConnection(connection: CloudConnection): CloudConnection {
  return {
    cloudUrl: connection.cloudUrl.replace(/\/+$/, ''),
    cloudToken: connection.cloudToken,
  };
}

function mapHttpStatusToPullError(status: number): PullError {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  return 'network';
}

export class DesktopTokenSyncTransport implements TokenSyncTransport {
  private readonly getCloudConnection: () => CloudConnection | null;
  private readonly fetchFn: FetchLike;

  constructor(args: {
    getCloudConnection: () => CloudConnection | null;
    fetchFn?: FetchLike;
  }) {
    this.getCloudConnection = args.getCloudConnection;
    this.fetchFn = args.fetchFn ?? fetch;
  }

  async publishSignal(signal: TokenSyncSignal): Promise<void> {
    const sent = cloudEventChannel.sendToCloud({
      channel: 'tokens:provider-changed',
      args: [signal],
    });
    if (!sent) {
      log.debug(
        { provider: signal.provider, accountKey: signal.accountKey },
        'Token sync signal not sent because cloud event channel is disconnected',
      );
    }
  }

  async pullMetadata(args: { provider: string; accountKey: string }): Promise<PullMetadataResult> {
    const connection = this.getCloudConnection();
    if (!connection) return { ok: false, error: 'unwired' };
    const cloud = normalizeConnection(connection);

    const route = buildRelayPath(args.provider, args.accountKey, '/metadata');
    let response: Response;
    try {
      response = await this.fetchFn(`${cloud.cloudUrl}${route}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${cloud.cloudToken}` },
      });
    } catch {
      return { ok: false, error: 'network' };
    }

    if (!response.ok) {
      return { ok: false, error: mapHttpStatusToPullError(response.status) };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: 'malformed' };
    }

    const parsed = body as {
      relativePath?: unknown;
      expiryEpochMs?: unknown;
      mtimeMs?: unknown;
      surfaceWrote?: unknown;
    };
    if (
      typeof parsed?.relativePath !== 'string'
      || typeof parsed.expiryEpochMs !== 'number'
      || typeof parsed.mtimeMs !== 'number'
      || (parsed.surfaceWrote !== 'desktop' && parsed.surfaceWrote !== 'cloud')
    ) {
      return { ok: false, error: 'malformed' };
    }

    return {
      ok: true,
      metadata: {
        provider: args.provider,
        accountKey: args.accountKey,
        relativePath: parsed.relativePath,
        expiryEpochMs: parsed.expiryEpochMs,
        mtimeMs: parsed.mtimeMs,
        surfaceWrote: parsed.surfaceWrote,
      },
    };
  }

  async pullToken(args: { provider: string; relativePath: string }): Promise<PullTokenResult> {
    const connection = this.getCloudConnection();
    if (!connection) return { ok: false, error: 'unwired' };
    const cloud = normalizeConnection(connection);

    const route = buildRelayPath(args.provider, args.relativePath);
    let response: Response;
    try {
      response = await this.fetchFn(`${cloud.cloudUrl}${route}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${cloud.cloudToken}` },
      });
    } catch {
      return { ok: false, error: 'network' };
    }

    if (!response.ok) {
      return { ok: false, error: mapHttpStatusToPullError(response.status) };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: 'malformed' };
    }

    const parsed = body as {
      content?: unknown;
      mtimeMs?: unknown;
      expiryEpochMs?: unknown;
      surfaceWrote?: unknown;
    };
    if (
      typeof parsed?.content !== 'string'
      || typeof parsed.mtimeMs !== 'number'
      || typeof parsed.expiryEpochMs !== 'number'
      || (parsed.surfaceWrote !== 'desktop' && parsed.surfaceWrote !== 'cloud')
    ) {
      return { ok: false, error: 'malformed' };
    }

    let content: Buffer;
    try {
      content = Buffer.from(parsed.content, 'base64');
    } catch {
      return { ok: false, error: 'malformed' };
    }

    return {
      ok: true,
      content,
      mtimeMs: parsed.mtimeMs,
      expiryEpochMs: parsed.expiryEpochMs,
      surfaceWrote: parsed.surfaceWrote,
    };
  }

  async pushTombstone(args: {
    provider: string;
    relativePath: string;
    tombstoneEpochMs: number;
  }): Promise<void> {
    const connection = this.getCloudConnection();
    if (!connection) return;
    const cloud = normalizeConnection(connection);

    const route = buildRelayPath(args.provider, args.relativePath);
    try {
      await this.fetchFn(`${cloud.cloudUrl}${route}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${cloud.cloudToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ tombstoneEpochMs: args.tombstoneEpochMs }),
      });
    } catch (error) {
      log.warn(
        {
          provider: args.provider,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to push token tombstone to cloud',
      );
    }
  }
}
