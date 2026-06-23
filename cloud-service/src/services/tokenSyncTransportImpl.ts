import type {
  PullMetadataResult,
  PullTokenResult,
  TokenSyncSignal,
  TokenSyncTransport,
} from '@core/setTokenSyncTransport';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';

export class CloudTokenSyncTransport implements TokenSyncTransport {
  async publishSignal(signal: TokenSyncSignal): Promise<void> {
    cloudEventBroadcaster.broadcast('tokens:provider-changed', signal);
  }

  async pullMetadata(_args: { provider: string; accountKey: string }): Promise<PullMetadataResult> {
    return { ok: false, error: 'unwired' };
  }

  async pullToken(_args: { provider: string; relativePath: string }): Promise<PullTokenResult> {
    return { ok: false, error: 'unwired' };
  }

  async pushTombstone(_args: {
    provider: string;
    relativePath: string;
    tombstoneEpochMs: number;
  }): Promise<void> {
    // Cloud transport has no remote peer endpoint today.
  }
}
